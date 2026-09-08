// D1 access for the dashboard. The SQL builders and the refresh state machine
// are pure (unit-tested); the exported async functions are the thin glue.

import type { UsageCache, UsageRow, HourlyRow } from '../data/cache';

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
		'imported_at' | 'time_zone' | 'refresh_requested_at' | 'refresh_started_at' | 'refresh_error',
		string
	>
>;

export interface RefreshStatus {
	/** True while a request is waiting for the ingest job to pick it up. */
	pending: boolean;
	phase: 'idle' | 'requested' | 'running' | 'failed';
	requestedAt?: string;
	startedAt?: string;
	importedAt?: string;
	error?: string;
}

/** ISO timestamps compare lexically. A request is live until a run started
 * after it, imported after it, or failed after it. */
export function refreshStatus(meta: Meta): RefreshStatus {
	const req = meta.refresh_requested_at;
	const started = meta.refresh_started_at;
	const imported = meta.imported_at;
	const base = { requestedAt: req, startedAt: started, importedAt: imported };
	if (!req || (imported && imported >= req)) return { ...base, pending: false, phase: 'idle' };
	if (started && started >= req) {
		return meta.refresh_error
			? { ...base, pending: false, phase: 'failed', error: meta.refresh_error }
			: { ...base, pending: false, phase: 'running' };
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
	/** Last chunk: sweep rows from older runs and stamp imported_at. */
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
	if (chunk.devices) {
		stmts.push(
			...insertStatements(
				'devices',
				['id', 'label'],
				Object.entries(chunk.devices),
				'ON CONFLICT (id) DO NOTHING'
			)
		);
	}
	if (chunk.rows?.length) {
		stmts.push(
			...insertStatements(
				'usage',
				['source', 'device', 'date', 'bundle_id', 'seconds', 'run_id'],
				chunk.rows.map((r) => [r.source, r.device, r.date, r.bundleId, r.seconds, chunk.runId]),
				'ON CONFLICT (source, device, date, bundle_id) DO UPDATE SET seconds = excluded.seconds, run_id = excluded.run_id'
			)
		);
	}
	if (chunk.hourly?.length) {
		stmts.push(
			...insertStatements(
				'hourly',
				['device', 'date', 'hour', 'bundle_id', 'seconds', 'run_id'],
				chunk.hourly.map((h) => [h.device, h.date, h.hour, h.bundleId, h.seconds, chunk.runId]),
				'ON CONFLICT (device, date, hour, bundle_id) DO UPDATE SET seconds = excluded.seconds, run_id = excluded.run_id'
			)
		);
	}
	if (chunk.final) {
		stmts.push(
			{ sql: 'DELETE FROM usage WHERE run_id != ?', params: [chunk.runId] },
			{ sql: 'DELETE FROM hourly WHERE run_id != ?', params: [chunk.runId] },
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
	if (!meta.imported_at) return null;
	const [usage, hourly, devices] = await db.batch([
		db.prepare('SELECT source, device, date, bundle_id AS bundleId, seconds FROM usage'),
		db.prepare('SELECT device, date, hour, bundle_id AS bundleId, seconds FROM hourly'),
		db.prepare('SELECT id, label FROM devices')
	]);
	return {
		version: 1,
		importedAt: meta.imported_at,
		timeZone: meta.time_zone ?? 'UTC',
		devices: Object.fromEntries(
			(devices.results as { id: string; label: string }[]).map((d) => [d.id, d.label])
		),
		rows: usage.results as UsageRow[],
		hourly: hourly.results as HourlyRow[]
	};
}
