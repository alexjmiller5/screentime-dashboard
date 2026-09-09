// D1 access for the dashboard. The SQL builders and the refresh state machine
// are pure (unit-tested); the exported async functions are the thin glue.

import { buildUsageCache, type UsageCache, type UsageRow, type HourlyRow } from '../data/cache';
import { retainPreviousUsage } from '../data/retained';
import { guessLabels } from '../import/labels';
import { readImportedScan } from './incremental';
import { jobStatus, type JobStage } from './refresh-job';

/** D1 allows 100 bound parameters per statement; every table here has <= 6 columns. */
export const ROWS_PER_STATEMENT = 16;
const STATEMENTS_PER_BATCH = 100;

export interface Statement {
	sql: string;
	params: unknown[];
}

export function insertStatements(
	table: string,
	columns: string[],
	rows: unknown[][],
	conflict = ''
): Statement[] {
	const tuple = `(${columns.map(() => '?').join(', ')})`;
	const out: Statement[] = [];
	for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
		const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
		out.push({
			sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => tuple).join(', ')}${conflict ? ' ' + conflict : ''}`,
			params: chunk.flat()
		});
	}
	return out;
}

export type Meta = Partial<
	Record<
		| 'data_updated_at'
		| 'imported_at'
		| 'time_zone'
		| 'refresh_requested_at'
		| 'refresh_kind'
		| 'refresh_started_at'
		| 'refresh_error'
		| 'refresh_job',
		string
	>
>;

/** dump = fresh Screen Time snapshot first; rebuild = re-parse what's there. */
export type RefreshKind = 'dump' | 'rebuild';
export const isRefreshKind = (v: unknown): v is RefreshKind => v === 'dump' || v === 'rebuild';

/** A run that has neither imported nor reported an error this long after it
 * started is presumed dead (the machine slept, the process was killed): the
 * request goes back to pending so the normal bounded retry picks it up, and
 * the UI stops showing a run that will never finish. */
export const STALE_RUN_MS = 30 * 60_000;

/** Longest a pending long-poll may hold before answering "nothing yet". */
export const MAX_WAIT_SECONDS = 30;
export function clampWait(raw: string | null): number {
	const n = Number(raw);
	return Number.isFinite(n) ? Math.min(MAX_WAIT_SECONDS, Math.max(0, Math.floor(n))) : 0;
}

export interface RefreshStatus {
	requestId?: string;
	stage?: JobStage;
	heartbeatAt?: string;
	confirmed?: boolean;
	retryAt?: string;
	detail?: string;
	/** True while a request is waiting for the ingest job to pick it up. */
	pending: boolean;
	phase: 'idle' | 'requested' | 'running' | 'failed';
	kind: RefreshKind;
	requestedAt?: string;
	startedAt?: string;
	importedAt?: string;
	error?: string;
}

/** ISO timestamps compare lexically. A request is live until a run started
 * after it, imported after it, or failed after it - or until that run goes
 * stale (see STALE_RUN_MS), which makes it live again. */
export function refreshStatus(meta: Meta, now = Date.now()): RefreshStatus {
	if (meta.refresh_job) return jobStatus(JSON.parse(meta.refresh_job), now);
	const req = meta.refresh_requested_at;
	const started = meta.refresh_started_at;
	const imported = meta.imported_at;
	const base = {
		kind: isRefreshKind(meta.refresh_kind) ? meta.refresh_kind : ('dump' as const),
		requestedAt: req,
		startedAt: started,
		importedAt: imported
	};
	if (!req || (imported && imported >= req)) return { ...base, pending: false, phase: 'idle' };
	if (started && started >= req) {
		if (meta.refresh_error) {
			return { ...base, pending: false, phase: 'failed', error: meta.refresh_error };
		}
		const stale = now - Date.parse(started) > STALE_RUN_MS;
		if (!stale) return { ...base, pending: false, phase: 'running' };
	}
	if (meta.refresh_error && !started) {
		return { ...base, pending: false, phase: 'failed', error: meta.refresh_error };
	}
	return { ...base, pending: true, phase: 'requested' };
}

export async function readMeta(db: D1Database): Promise<Meta> {
	const { results } = await db
		.prepare('SELECT key, value FROM meta')
		.all<{ key: string; value: string }>();
	return Object.fromEntries(results.map((r) => [r.key, r.value])) as Meta;
}

export function metaStatements(entries: Partial<Meta>): Statement[] {
	return Object.entries(entries).map(([key, value]) =>
		value === undefined
			? { sql: 'DELETE FROM meta WHERE key = ?', params: [key] }
			: {
					sql: 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
					params: [key, value]
				}
	);
}

export async function runStatements(db: D1Database, stmts: Statement[]): Promise<void> {
	for (let i = 0; i < stmts.length; i += STATEMENTS_PER_BATCH) {
		await db.batch(
			stmts.slice(i, i + STATEMENTS_PER_BATCH).map((s) => db.prepare(s.sql).bind(...s.params))
		);
	}
}

export interface IngestChunk {
	runId: string;
	timeZone?: string;
	/** Guessed labels: inserted only for devices the table doesn't know yet. */
	devices?: Record<string, string>;
	rows?: UsageRow[];
	hourly?: HourlyRow[];
	/** Marks the run as started (clears a previous error). */
	started?: boolean;
	/** Successful sync marker; never deletes historical data. */
	final?: boolean;
	/** The run failed; recorded for the UI. */
	error?: string;
}

export function ingestStatements(chunk: IngestChunk, now: string): Statement[] {
	const stmts: Statement[] = [];
	if (chunk.started) {
		stmts.push(...metaStatements({ refresh_started_at: now, refresh_error: undefined }));
	}
	if (chunk.error !== undefined) {
		stmts.push(...metaStatements({ refresh_error: chunk.error }));
	}
	if (chunk.final) {
		stmts.push(
			...metaStatements({
				imported_at: now,
				...(chunk.timeZone ? { time_zone: chunk.timeZone } : {}),
				refresh_error: undefined
			})
		);
	}
	return stmts;
}

export async function readUsageCache(db: D1Database): Promise<UsageCache | null> {
	const meta = await readMeta(db);
	if (!meta.imported_at && !meta.data_updated_at) return null;
	const [usage, hourly, devices] = await db.batch([
		db.prepare('SELECT source, device, date, bundle_id AS bundleId, seconds FROM usage'),
		db.prepare('SELECT device, date, hour, bundle_id AS bundleId, seconds FROM hourly'),
		db.prepare('SELECT id, label FROM devices')
	]);
	const previous: UsageCache = {
		version: 1,
		importedAt: meta.data_updated_at ?? meta.imported_at!,
		timeZone: meta.time_zone ?? 'UTC',
		devices: Object.fromEntries(
			(devices.results as { id: string; label: string }[]).map((d) => [d.id, d.label])
		),
		rows: usage.results as UsageRow[],
		hourly: hourly.results as HourlyRow[]
	};
	const scan = await readImportedScan(db);
	return retainPreviousUsage(
		previous,
		buildUsageCache({
			...scan,
			timeZone: previous.timeZone,
			importedAt: previous.importedAt,
			devices: guessLabels(scan, previous.devices)
		})
	);
}
