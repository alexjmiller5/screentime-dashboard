#!/usr/bin/env bun
/// <reference types="bun" />
// screentime-ingest: rebuild the dashboard's series from the local
// screentime-backup folder and push them to the Worker's D1.
//
//   screentime-ingest sync   parse every snapshot, push to the dashboard
//   screentime-ingest poll   ask the dashboard whether a refresh was requested;
//                            if so kick the backup agent (whose post-run hook
//                            runs `sync`), or run `sync` inline without one
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
//                                            (remembers the last refresh request handled)

import { Database } from 'bun:sqlite';
import { homedir, tmpdir } from 'node:os';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importBackups } from '../lib/import/importer';
import { buildUsageCache } from '../lib/data/cache';
import { guessLabels } from '../lib/import/labels';
import { fsDir } from './fsdir';
import { DashboardClient, planChunks, shouldHandle, type Credential } from './client';

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

async function sync(): Promise<void> {
	const url = required('SCREENTIME_DASHBOARD_URL');
	const backups = env.SCREENTIME_BACKUPS_DIR ?? join(homedir(), 'Documents', 'screen-time-backups');
	const timeZone = env.SCREENTIME_TIME_ZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const runId = new Date().toISOString();
	const client = new DashboardClient(url, await credential());
	await client.post({ runId, started: true });
	try {
		const scan = await importBackups(fsDir(backups), { querySqlite, onProgress: log });
		if (scan.snapshots.length === 0) throw new Error(`no snapshots under ${backups}`);
		for (const e of scan.errors) log(`WARN ${e}`);
		const cache = buildUsageCache({
			timeZone,
			importedAt: runId,
			devices: guessLabels(scan),
			focusEventsByDevice: scan.focusEventsByDevice,
			knowledgecSessionsByDevice: scan.knowledgecSessionsByDevice,
			deviceActivityByDevice: scan.deviceActivityByDevice
		});
		const chunks = planChunks(cache, runId);
		log(
			`${scan.snapshots.length} snapshots -> ${cache.rows.length} rows, ${cache.hourly?.length ?? 0} hourly; ${chunks.length} chunks`
		);
		for (const chunk of chunks) await client.post(chunk);
		log('sync done');
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await client.post({ runId, error: message }).catch(() => {});
		throw error;
	}
}

async function launchdRunning(label: string): Promise<boolean> {
	const proc = Bun.spawn(['/bin/launchctl', 'print', `gui/${process.getuid?.() ?? 501}/${label}`], {
		stdout: 'pipe',
		stderr: 'ignore'
	});
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return /state = running/.test(out);
}

const stateDir = env.SCREENTIME_STATE_DIR ?? join(homedir(), 'Library', 'Application Support', 'screentime-ingest');
const lastHandledFile = join(stateDir, 'last-handled-request');

async function poll(): Promise<void> {
	const url = required('SCREENTIME_DASHBOARD_URL');
	const pending = await DashboardClient.pending(url);
	const lastHandled = await readFile(lastHandledFile, 'utf8').catch(() => null);
	// Exactly one attempt per request: a sync that dies before it can report
	// leaves the flag up, and re-kicking a full backup every minute is how a
	// 1Password budget gets burned. Alex hits Refresh again to retry.
	if (!shouldHandle(pending, lastHandled?.trim() ?? null)) return;
	await mkdir(stateDir, { recursive: true });
	await writeFile(lastHandledFile, pending!);
	const label = env.SCREENTIME_BACKUP_LABEL;
	if (!label) {
		log('refresh requested - syncing inline');
		return sync();
	}
	// The backup agent's post-run hook runs `sync`; don't restart a run in flight.
	if (await launchdRunning(label)) {
		log(`refresh requested - ${label} already running`);
		return;
	}
	log(`refresh requested - kickstarting ${label}`);
	const proc = Bun.spawn(
		['/bin/launchctl', 'kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${label}`],
		{
			stdout: 'inherit',
			stderr: 'inherit'
		}
	);
	if ((await proc.exited) !== 0) throw new Error(`launchctl kickstart ${label} failed`);
}

const command = process.argv[2];
try {
	if (command === 'sync') await sync();
	else if (command === 'poll') await poll();
	else {
		console.error('usage: screentime-ingest sync | poll');
		process.exit(2);
	}
} catch (error) {
	log(`ERROR ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
