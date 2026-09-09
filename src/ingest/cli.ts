#!/usr/bin/env bun
/// <reference types="bun" />
// screentime-ingest: rebuild the dashboard's series from the local
// screentime-backup folder and push them to the Worker's D1.
//
//   screentime-ingest sync   parse every snapshot, push to the dashboard
//   screentime-ingest watch  daemon: long-poll the dashboard for refresh
//                            requests and act on each - kick the backup agent
//                            (whose post-run hook runs `sync`; a "rebuild"
//                            request sets the skip-dump flag first), or run
//                            `sync` inline when there is no backup agent.
//                            Bounded retries with growing gaps per request.
//   screentime-ingest poll   one pass of the above, no hold (cron-style)
//
// Config (env):
//   SCREENTIME_DASHBOARD_URL                 https://<dashboard host>      (required)
//   SCREENTIME_DASHBOARD_CREDENTIAL_COMMAND  prints {"clientId","clientSecret"} - a
//                                            Cloudflare Access service token (sync)
//   SCREENTIME_DASHBOARD_CLIENT_ID/_SECRET   literal alternative to the command
//   SCREENTIME_BACKUPS_DIR                   default ~/Documents/screen-time-backups
//   SCREENTIME_BACKUP_LABEL                  launchd label `poll` kickstarts; unset =
//                                            poll runs sync itself
//   SCREENTIME_TIME_ZONE                     default: the system time zone
//   SCREENTIME_STATE_DIR                     default ~/Library/Application Support/screentime-ingest
//                                            (attempt state + the skip-dump flag file)
//   SCREENTIME_HOLD_SECONDS                  long-poll hold per request (default 30, max 30)
//   SCREENTIME_READ_TIMEOUT_MS               per-file read timeout (default 120000) - an
//                                            iCloud-evicted file that never arrives is
//                                            skipped, not waited on forever

import { Database } from 'bun:sqlite';
import type { JobUpdate } from '../lib/server/refresh-job';
import { homedir, tmpdir } from 'node:os';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { syncBackups, type FetchFn } from '../lib/import/incremental';
import { DEFAULT_READ_TIMEOUT_MS, fsDir } from './fsdir';
import {
	afterFailedAttempt,
	DashboardClient,
	planAttempt,
	type AttemptState,
	type Credential,
	type PendingRequest
} from './client';

const env = process.env;
const log = (msg: string): void => console.log(`[${new Date().toISOString()}] ${msg}`);

function required(name: string): string {
	const v = env[name];
	if (!v) throw new Error(`${name} is not set`);
	return v;
}

async function credential(): Promise<Credential> {
	if (env.SCREENTIME_DASHBOARD_CLIENT_ID && env.SCREENTIME_DASHBOARD_CLIENT_SECRET) {
		return {
			clientId: env.SCREENTIME_DASHBOARD_CLIENT_ID,
			clientSecret: env.SCREENTIME_DASHBOARD_CLIENT_SECRET
		};
	}
	const cmd = required('SCREENTIME_DASHBOARD_CREDENTIAL_COMMAND');
	const proc = Bun.spawn(['/bin/sh', '-c', cmd], { stdout: 'pipe', stderr: 'inherit' });
	const out = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) throw new Error('credential command failed');
	const parsed = JSON.parse(out) as Partial<Credential>;
	if (!parsed.clientId || !parsed.clientSecret)
		throw new Error('credential command: need clientId + clientSecret');
	return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
}

async function querySqlite(dbBytes: Uint8Array, sql: string): Promise<unknown[][]> {
	// Via a temp file, not Database.deserialize: the in-memory path rejects some
	// of the larger knowledgeC images ("unable to open database file"). Opened
	// read-write on purpose - the newer images are WAL-mode, and a readonly
	// open of a WAL database fails the same way (it cannot create the -shm).
	const path = join(tmpdir(), `screentime-ingest-${process.pid}-${Date.now()}.db`);
	await writeFile(path, dbBytes);
	try {
		const db = new Database(path);
		try {
			return db.query(sql).values();
		} finally {
			db.close();
		}
	} finally {
		await unlink(path).catch(() => {});
	}
}

async function sync(force = false, context?: JobContext): Promise<void> {
	const url = required('SCREENTIME_DASHBOARD_URL');
	const backups = env.SCREENTIME_BACKUPS_DIR ?? join(homedir(), 'Documents', 'screen-time-backups');
	const timeZone = env.SCREENTIME_TIME_ZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const runId = new Date().toISOString();
	const cred = await credential();
	const client = new DashboardClient(url, cred);
	const fetchFn: FetchFn = (input, init) => {
		const headers = new Headers(init?.headers);
		headers.set('CF-Access-Client-Id', cred.clientId);
		headers.set('CF-Access-Client-Secret', cred.clientSecret);
		return fetch(input, { ...init, headers, redirect: 'error' });
	};
	if (
		context &&
		!(await client.job({ ...context, stage: 'importing', detail: 'Checking backup files' }))
	)
		throw new Error('This refresh attempt is no longer active');
	await client.post({ runId, started: true });
	let detail = 'Checking backup files';
	let counts = '';
	let sending = false;
	const heartbeat = context
		? setInterval(async () => {
				if (sending) return;
				sending = true;
				try {
					await client.job({
						...context,
						stage: 'importing',
						detail: `${counts}${detail}`.slice(0, 500)
					});
				} catch (error) {
					log(`progress update failed: ${String(error)}`);
				} finally {
					sending = false;
				}
			}, 15_000)
		: undefined;
	try {
		const readTimeout = Number(env.SCREENTIME_READ_TIMEOUT_MS) || DEFAULT_READ_TIMEOUT_MS;
		const result = await syncBackups(fsDir(backups, undefined, readTimeout), {
			querySqlite,
			baseUrl: url,
			fetchFn,
			timeZone,
			onProgress: (message) => {
				log(message);
				detail = message.slice(0, 500);
			},
			onCounts: (value) => {
				counts = `${value.imported} imported, ${value.skipped} skipped, ${value.failed} unavailable · `;
			},
			force
		});
		log(
			`${result.imported} files imported, ${result.skipped} already imported, ${result.failed} unavailable`
		);
		for (const error of result.errors) log(`WARN ${error}`);
		if (result.failed || result.errors.length)
			throw new Error(
				`${result.failed} files unavailable; imported files and previous history are preserved. ${result.errors[0] ?? ''}`
			);
		await client.post({ runId, final: true });
		if (context && !(await client.job({ ...context, stage: 'complete', detail })))
			throw new Error('The refresh was superseded before completion');
		log('sync done');
	} catch (error) {
		// Preserve the failure detail for the watcher, which owns retry timing.
		if (context)
			await client
				.job({
					...context,
					stage: 'importing',
					detail: `Import stopped: ${error instanceof Error ? error.message : String(error)}`.slice(
						0,
						500
					)
				})
				.catch(() => {});
		await client
			.post({ runId, error: error instanceof Error ? error.message : String(error) })
			.catch(() => {});
		throw error;
	} finally {
		clearInterval(heartbeat);
	}
}

const stateDir =
	env.SCREENTIME_STATE_DIR ??
	join(homedir(), 'Library', 'Application Support', 'screentime-ingest');
const stateFile = join(stateDir, 'attempt.json');
interface JobContext {
	requestId: string;
	runId: string;
	watchPid: number;
	createdAt: number;
}
const contextFile = join(stateDir, 'active-job.json');
async function readContext(): Promise<JobContext | undefined> {
	try {
		const context = JSON.parse(await readFile(contextFile, 'utf8')) as JobContext;
		if (
			typeof context.requestId !== 'string' ||
			typeof context.runId !== 'string' ||
			!Number.isInteger(context.watchPid) ||
			!Number.isFinite(context.createdAt) ||
			Date.now() - context.createdAt > 35 * 60_000
		)
			return;
		process.kill(context.watchPid, 0);
		return context;
	} catch {
		return;
	}
}
/** Touched before a rebuild kick: the backup agent sees it and runs only its
 * post-run hook (screentime-backup's skipDumpFlag must point here). */
const skipDumpFlag = join(stateDir, 'skip-dump');
const uid = process.getuid?.() ?? 501;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function readState(): Promise<AttemptState | null> {
	try {
		return JSON.parse(await readFile(stateFile, 'utf8')) as AttemptState;
	} catch {
		return null;
	}
}
async function writeState(state: AttemptState): Promise<void> {
	await mkdir(stateDir, { recursive: true });
	const temporary = `${stateFile}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(state));
	await rename(temporary, stateFile);
}

async function launchctl(...args: string[]): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(['/bin/launchctl', ...args], { stdout: 'pipe', stderr: 'pipe' });
	const out = await new Response(proc.stdout).text();
	return { code: await proc.exited, out };
}
const launchdRunning = async (label: string): Promise<boolean> =>
	/state = running/.test((await launchctl('print', `gui/${uid}/${label}`)).out);

/** Kick the backup agent and wait for it to finish (it runs the sync as its
 * post-run hook). Resolves once the agent is idle again or after `maxMs`. */
async function kickAndWait(
	label: string,
	maxMs: number,
	client: DashboardClient,
	context: JobContext,
	kind: PendingRequest['kind']
): Promise<void> {
	const { code } = await launchctl('kickstart', `gui/${uid}/${label}`);
	if (code !== 0) throw new Error(`launchctl kickstart ${label} failed`);
	const deadline = Date.now() + maxMs;
	// A successful kick is only a launch request. Confirm that launchd sees
	// the process before claiming the backup is running.
	if (kind === 'dump' && (await launchdRunning(label)))
		await client.job({ ...context, stage: 'copying', detail: 'Backup process is running' });
	let lastHeartbeat = Date.now();
	await sleep(1000);
	while (await launchdRunning(label)) {
		if (Date.now() >= deadline) throw new Error('Backup is still running; retry after it finishes');
		if (Date.now() - lastHeartbeat >= 15_000) {
			await client
				.job({ ...context, stage: 'heartbeat' })
				.catch((error) => log(`heartbeat failed: ${String(error)}`));
			lastHeartbeat = Date.now();
		}
		await sleep(1000);
	}
}

async function attempt(
	req: PendingRequest,
	client: DashboardClient,
	context: JobContext
): Promise<void> {
	const label = env.SCREENTIME_BACKUP_LABEL;
	if (!label) return sync(req.kind === 'rebuild', context);
	if (await launchdRunning(label))
		throw new Error('A backup is already running; retry after it finishes');
	await mkdir(stateDir, { recursive: true });
	await writeFile(contextFile, JSON.stringify(context));
	try {
		if (req.kind === 'rebuild') {
			await writeFile(skipDumpFlag, req.id);
			await writeFile(join(stateDir, 'rebuild'), req.id);
		} else {
			await unlink(skipDumpFlag).catch(() => {});
			await unlink(join(stateDir, 'rebuild')).catch(() => {});
		}
		await kickAndWait(label, 35 * 60_000, client, context, req.kind);
		const status = await client.status();
		if (status.requestId === req.id && status.stage !== 'complete')
			throw new Error(
				status.error ??
					`Backup exited before completing the import${status.detail ? `. ${status.detail}` : ''}`
			);
	} finally {
		await unlink(contextFile).catch(() => {});
	}
}

/** One pass: ask (holding up to `holdSeconds`), plan, maybe attempt. Returns
 * how long the caller should idle before asking again. */
async function pass(url: string, holdSeconds: number): Promise<number> {
	const req = await DashboardClient.pending(url, fetch, holdSeconds);
	if (!req) return holdSeconds > 0 ? 0 : 1000;
	const state = await readState();
	const plan = planAttempt(req, state, Date.now());
	if (plan.action === 'wait') return Math.min(plan.ms, holdSeconds * 1000 || 30_000);
	if (plan.action === 'exhausted') return holdSeconds * 1000 || 30_000;
	// Persist before starting: process termination must not reset the attempt budget.
	await writeState(afterFailedAttempt(req, state, Date.now()));
	let client: DashboardClient | undefined;
	const context: JobContext = {
		requestId: req.id,
		runId: crypto.randomUUID(),
		watchPid: process.pid,
		createdAt: Date.now()
	};
	let claimed = false;
	try {
		// Credentials are read once for an actual attempt, never for idle polls
		// or individual heartbeat messages, and are held only in memory.
		client = new DashboardClient(url, await credential());
		claimed = await client.job({ ...context, stage: 'accepted' });
		if (!claimed) return 0;
		await attempt(req, client, context);
		return 0;
	} catch (error) {
		const next = afterFailedAttempt(req, state, Date.now());
		await writeState(next);
		if (client && claimed) {
			const stage: JobUpdate['stage'] = Number.isFinite(next.nextAttemptAt) ? 'retrying' : 'failed';
			await client
				.job({
					...context,
					stage,
					detail: String(error instanceof Error ? error.message : error).slice(0, 500),
					...(stage === 'retrying' ? { retryAt: new Date(next.nextAttemptAt).toISOString() } : {})
				})
				.catch((error) => log(`could not report failure: ${String(error)}`));
		}
		const retryIn = Number.isFinite(next.nextAttemptAt)
			? `${Math.round((next.nextAttemptAt - Date.now()) / 60_000)} min`
			: 'never (giving up on this request)';
		log(
			`attempt ${next.attempts} failed: ${error instanceof Error ? error.message : String(error)}; next in ${retryIn}`
		);
		return 1000;
	}
}

const holdSeconds = Math.min(30, Math.max(0, Number(env.SCREENTIME_HOLD_SECONDS ?? 30) || 0));

async function poll(): Promise<void> {
	await pass(required('SCREENTIME_DASHBOARD_URL'), 0);
}

async function watch(): Promise<never> {
	const url = required('SCREENTIME_DASHBOARD_URL');
	log(`watching ${url} (hold ${holdSeconds}s)`);
	for (;;) {
		try {
			await sleep(await pass(url, holdSeconds));
		} catch (error) {
			// Network/Worker hiccup: never spin, never touch a credential here.
			log(`poll error: ${error instanceof Error ? error.message : String(error)}`);
			await sleep(15_000);
		}
	}
}

const command = process.argv[2];
try {
	if (command === 'sync') {
		const flag = join(stateDir, 'rebuild');
		const rebuild = await readFile(flag, 'utf8').catch(() => '');
		if (rebuild) await unlink(flag).catch(() => {});
		await sync(Boolean(rebuild) || process.argv.includes('--force'), await readContext());
	} else if (command === 'poll') await poll();
	else if (command === 'watch') await watch();
	else {
		console.error('usage: screentime-ingest sync | watch | poll');
		process.exit(2);
	}
} catch (error) {
	log(`ERROR ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
