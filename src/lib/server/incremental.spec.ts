import { readFileSync } from 'node:fs';
import initSqlJs, { type Database, type SqlValue } from 'sql.js';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { GET, POST } from '../../routes/api/imports/+server';
import { readImportedScan } from './incremental';
import { buildUsageCache } from '../data/cache';
import type { ImportResult } from '../import/importer';

let sqlite: Database;
let db: D1Database;
let transferredRows = 0;
beforeEach(async () => {
	const SQL = await initSqlJs();
	sqlite = new SQL.Database();
	sqlite.run('PRAGMA foreign_keys = ON');
	for (const name of ['0001_init.sql', '0002_incremental_imports.sql'])
		sqlite.run(readFileSync(`migrations/${name}`, 'utf8'));
	const prepare = (sql: string, params: SqlValue[] = []): unknown => ({
		bind: (...values: SqlValue[]) => prepare(sql, values),
		all: async () => execute(sql, params),
		run: async () => execute(sql, params),
		first: async (column?: string) => {
			const row = execute(sql, params).results[0];
			return column ? (row?.[column] ?? null) : (row ?? null);
		},
		execute: () => execute(sql, params)
	});
	function execute(sql: string, params: SqlValue[]) {
		const stmt = sqlite.prepare(sql);
		try {
			stmt.bind(params);
			const results = [];
			while (stmt.step()) results.push(stmt.getAsObject());
			transferredRows += results.length;
			return { results, success: true, meta: { changes: sqlite.getRowsModified() } };
		} finally {
			stmt.free();
		}
	}
	db = {
		prepare,
		batch: async (stmts: { execute: () => unknown }[]) => {
			sqlite.run('BEGIN');
			try {
				const results = stmts.map((s) => s.execute());
				sqlite.run('COMMIT');
				return results;
			} catch (e) {
				sqlite.run('ROLLBACK');
				throw e;
			}
		}
	} as unknown as D1Database;
});
afterEach(() => sqlite?.close());

function scan(seconds = 60): ImportResult {
	return {
		snapshots: ['2026-01-01'],
		errors: [],
		focusEventsByDevice: {
			'device-1': [
				{ tsMs: 1767225600000, bundleId: 'example.app', focus: true },
				{ tsMs: 1767225660000, bundleId: 'example.app', focus: false }
			]
		},
		knowledgecSessionsByDevice: {
			'device-2': [{ bundleId: 'example.app', startMs: 1767225600000, endMs: 1767225660000 }]
		},
		deviceActivityByDevice: {
			'device-1': [{ cocoaSeconds: 788918400, entries: [{ key: 'example.app', seconds }] }]
		}
	};
}
const path = '2026-01-01/biome-streams.tar.gz';
const hash = 'a'.repeat(64);
async function post(payload: unknown) {
	return POST({
		platform: { env: { DB: db } },
		request: new Request('https://example.com/api/imports', {
			method: 'POST',
			body: JSON.stringify(payload)
		})
	} as Parameters<typeof POST>[0]);
}
async function ledger() {
	return (
		await GET({ platform: { env: { DB: db } } } as Parameters<typeof GET>[0])
	).json() as Promise<{
		files: { path: string; hash: string; parserVersion: number }[];
		timeZone?: string;
	}>;
}
async function begin(filePath = path, fileHash = hash, timeZone = 'UTC') {
	const response = await post({
		action: 'begin',
		path: filePath,
		hash: fileHash,
		parserVersion: 1,
		timeZone
	});
	expect(response.status).toBe(200);
	return ((await response.json()) as { uploadId: string }).uploadId;
}
const chunk = (uploadId: string, index = 0, value = scan()) =>
	post({ action: 'chunk', uploadId, index, scan: value });
const complete = (uploadId: string, chunks = 1) => post({ action: 'complete', uploadId, chunks });
async function upload(filePath = path, value = scan()) {
	const id = await begin(filePath);
	expect((await chunk(id, 0, value)).status).toBe(204);
	expect((await complete(id)).status).toBe(204);
	return id;
}

it('exposes only committed files and retains prior data through incomplete or unreadable replacements', async () => {
	expect(await ledger()).toEqual({ files: [] });
	await upload();
	const replacement = await begin(path, 'b'.repeat(64));
	expect((await chunk(replacement, 0, scan(120))).status).toBe(204);
	expect((await complete(replacement, 2)).status).toBe(409);
	expect((await chunk(replacement, 1, { ...scan(), errors: ['unreadable'] })).status).toBe(400);
	expect(await ledger()).toEqual({ files: [{ path, hash, parserVersion: 1 }], timeZone: 'UTC' });
	expect(
		(await readImportedScan(db)).deviceActivityByDevice['device-1'][0].entries[0].seconds
	).toBe(60);
	expect((await complete(replacement)).status).toBe(204);
	expect(
		(await readImportedScan(db)).deviceActivityByDevice['device-1'][0].entries[0].seconds
	).toBe(120);
});

it('keeps independent concurrent imports and rejects stale same-file replacements including first import races', async () => {
	const first = await begin();
	const stale = await begin(path, 'b'.repeat(64));
	const other = await begin('2026-01-02/biome-streams.tar.gz');
	for (const id of [first, stale, other]) expect((await chunk(id)).status).toBe(204);
	expect((await complete(first)).status).toBe(204);
	expect((await complete(other)).status).toBe(204);
	expect((await complete(stale)).status).toBe(409);
	const next = await begin(path, 'c'.repeat(64));
	const staleNext = await begin(path, 'd'.repeat(64));
	for (const id of [next, staleNext]) expect((await chunk(id)).status).toBe(204);
	expect((await complete(next)).status).toBe(204);
	expect((await complete(staleNext)).status).toBe(409);
	expect((await ledger()).files).toHaveLength(2);
});

it('requires exact contiguous chunks and makes chunk and completion retries idempotent', async () => {
	const id = await begin();
	expect((await chunk(id, 1)).status).toBe(204);
	expect((await complete(id, 1)).status).toBe(409);
	expect((await complete(id, 2)).status).toBe(409);
	expect((await chunk(id, 0)).status).toBe(204);
	expect((await chunk(id, 0)).status).toBe(204);
	expect((await chunk(id, 0, scan(90))).status).toBe(409);
	expect((await complete(id, 1)).status).toBe(409);
	expect((await complete(id, 2)).status).toBe(204);
	expect((await complete(id, 2)).status).toBe(204);
	expect((await chunk(id, 0)).status).toBe(204);
	expect((await chunk(id, 2)).status).toBe(409);
	expect((await readImportedScan(db)).focusEventsByDevice['device-1']).toHaveLength(2);
});

it('deduplicates in SQL while preserving file order and buildUsageCache results', async () => {
	await upload('2026-01-02/device-activity.tar.gz', scan(120));
	await upload('2026-01-01/device-activity.tar.gz', scan(60));
	transferredRows = 0;
	const merged = await readImportedScan(db);
	expect(transferredRows).toBe(7);
	expect(merged.focusEventsByDevice['device-1']).toHaveLength(2);
	expect(merged.knowledgecSessionsByDevice['device-2']).toHaveLength(1);
	expect(merged.snapshots).toEqual(['2026-01-01', '2026-01-02']);
	const cache = buildUsageCache({
		...merged,
		timeZone: 'UTC',
		importedAt: '2026-01-03T00:00:00Z',
		devices: {}
	});
	expect(cache.rows.filter((r) => r.source === 'screentime').map((r) => r.seconds)).toEqual([120]);
	expect(cache.rows.filter((r) => r.source === 'infocus').map((r) => r.seconds)).toEqual([60]);
	expect(cache.rows.filter((r) => r.source === 'knowledgec').map((r) => r.seconds)).toEqual([60]);
	expect((await ledger()).timeZone).toBe('UTC');
});

it('can commit a successfully parsed empty file without dropping another file', async () => {
	await upload();
	const id = await begin('2026-01-02/knowledgeC.db.gz');
	expect((await complete(id, 0)).status).toBe(400);
	expect(
		(
			await chunk(id, 0, {
				snapshots: ['2026-01-02'],
				errors: [],
				focusEventsByDevice: {},
				knowledgecSessionsByDevice: {},
				deviceActivityByDevice: {}
			})
		).status
	).toBe(204);
	expect((await complete(id, 1)).status).toBe(204);
	expect((await ledger()).files).toHaveLength(2);
	expect((await readImportedScan(db)).snapshots).toEqual(['2026-01-01', '2026-01-02']);
});

it('validates payload shape, limits, identifiers and all nested parsed records', async () => {
	for (const payload of [
		null,
		[],
		{},
		{ action: 'bogus' },
		{ action: 'begin', path: '../file', hash, parserVersion: 1, timeZone: 'UTC' },
		{ action: 'begin', path, hash: 'bad', parserVersion: 1, timeZone: 'UTC' },
		{ action: 'begin', path, hash, parserVersion: 0, timeZone: 'UTC' },
		{ action: 'begin', path, hash, parserVersion: 1, timeZone: 'no/such-zone' }
	])
		expect((await post(payload)).status).toBe(400);
	const id = await begin();
	for (const value of [
		null,
		{},
		{ ...scan(), focusEventsByDevice: { constructor: [] } },
		{ ...scan(), focusEventsByDevice: { d: [{ tsMs: 1, bundleId: 'a', focus: 1 }] } },
		{ ...scan(), knowledgecSessionsByDevice: { d: [{ bundleId: 'a', startMs: 10, endMs: 1 }] } },
		{
			...scan(),
			deviceActivityByDevice: { d: [{ cocoaSeconds: 0, entries: [{ key: 'a', seconds: -1 }] }] }
		},
		{
			...scan(),
			deviceActivityByDevice: { d: [{ cocoaSeconds: 0, hourly: false, entries: [] }] }
		}
	])
		expect((await post({ action: 'chunk', uploadId: id, index: 0, scan: value })).status).toBe(400);
	expect((await chunk(id, -1)).status).toBe(400);
	expect((await complete(id, 0.5)).status).toBe(400);
	expect((await chunk('00000000-0000-4000-8000-000000000000')).status).toBe(404);
	expect(
		(
			await post({
				action: 'chunk',
				uploadId: id,
				index: 0,
				scan: { ...scan(), snapshots: ['x'.repeat(1024 * 1024)] }
			})
		).status
	).toBe(413);
	expect(await ledger()).toEqual({ files: [] });
});

it('rolls back the pointer if a transactional completion fails', async () => {
	await upload();
	const id = await begin(path, 'b'.repeat(64));
	expect((await chunk(id, 0, scan(120))).status).toBe(204);
	sqlite.run(
		"CREATE TRIGGER fail_complete BEFORE UPDATE OF completed_chunks ON import_uploads BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
	);
	await expect(complete(id)).rejects.toThrow('injected failure');
	expect((await ledger()).files[0].hash).toBe(hash);
	expect(
		(await readImportedScan(db)).deviceActivityByDevice['device-1'][0].entries[0].seconds
	).toBe(60);
});

it('stamps only data metadata and releases superseded contribution rows', async () => {
	sqlite.run(
		"INSERT INTO meta VALUES ('imported_at','earlier'), ('refresh_started_at','running'), ('refresh_error','retained')"
	);
	const first = await upload();
	const id = await begin(path, 'b'.repeat(64));
	expect((await chunk(id, 0, scan(90))).status).toBe(204);
	expect((await complete(id)).status).toBe(204);
	const meta = Object.fromEntries(sqlite.exec('SELECT key,value FROM meta')[0].values);
	expect(meta).toMatchObject({
		imported_at: 'earlier',
		refresh_started_at: 'running',
		refresh_error: 'retained',
		time_zone: 'UTC'
	});
	expect(meta.data_updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	expect(
		sqlite.exec(`SELECT COUNT(*) FROM import_records WHERE upload_id = '${first}'`)[0].values[0][0]
	).toBe(0);
	expect((await chunk(first)).status).toBe(204);
	expect((await complete(first)).status).toBe(204);
	expect(
		(await readImportedScan(db)).deviceActivityByDevice['device-1'][0].entries[0].seconds
	).toBe(90);
});

it('a failed chunk rolls back its receipt and can be retried completely', async () => {
	const id = await begin();
	sqlite.run(
		"CREATE TRIGGER fail_record BEFORE INSERT ON import_records BEGIN SELECT RAISE(ABORT, 'injected chunk failure'); END"
	);
	await expect(chunk(id)).rejects.toThrow('injected chunk failure');
	expect((await complete(id)).status).toBe(409);
	sqlite.run('DROP TRIGGER fail_record');
	expect((await chunk(id)).status).toBe(204);
	expect((await complete(id)).status).toBe(204);
	expect((await readImportedScan(db)).focusEventsByDevice['device-1']).toHaveLength(2);
});

it('accepts a dense intact segment below the wire byte limit', async () => {
	const id = await begin();
	const value: ImportResult = {
		snapshots: ['2026-01-01'],
		errors: [],
		focusEventsByDevice: {},
		knowledgecSessionsByDevice: {},
		deviceActivityByDevice: {
			'00000000-0000-4000-8000-000000000001': [
				{
					cocoaSeconds: 788918400,
					entries: Array.from({ length: 9000 }, () => ({ key: 'a'.repeat(50), seconds: 1 }))
				}
			]
		}
	};
	expect((await chunk(id, 0, value)).status).toBe(204);
	expect((await complete(id)).status).toBe(204);
	expect(
		(await readImportedScan(db)).deviceActivityByDevice['00000000-0000-4000-8000-000000000001'][0]
			.entries
	).toHaveLength(9000);
});

it('the first committed timezone wins even when two clients begin before either commits', async () => {
	const first = await begin();
	const other = await begin('2026-01-02/device-activity.tar.gz', hash, 'Etc/GMT');
	expect((await chunk(first)).status).toBe(204);
	expect((await chunk(other)).status).toBe(204);
	expect((await complete(first)).status).toBe(204);
	const before = sqlite.exec('SELECT key,value FROM meta ORDER BY key');
	expect((await complete(other)).status).toBe(409);
	expect(await ledger()).toEqual({ files: [{ path, hash, parserVersion: 1 }], timeZone: 'UTC' });
	expect(sqlite.exec('SELECT key,value FROM meta ORDER BY key')).toEqual(before);
	const retry = await begin('2026-01-02/device-activity.tar.gz');
	expect((await chunk(retry)).status).toBe(204);
	expect((await complete(retry)).status).toBe(204);
	expect((await ledger()).files).toHaveLength(2);
});

it('selects complete latest segments in SQL, including repeated headers and empty replacements', async () => {
	await upload('2026-01-01/device-activity.tar.gz', scan(60));
	const latest = scan(100);
	latest.deviceActivityByDevice['device-1'].push({
		cocoaSeconds: 788918400,
		entries: [{ key: 'example.other', seconds: 30 }]
	});
	const id = await begin('2026-01-02/device-activity.tar.gz');
	expect((await chunk(id, 0, latest)).status).toBe(204);
	expect((await complete(id)).status).toBe(204);
	let merged = await readImportedScan(db);
	expect(merged.deviceActivityByDevice['device-1']).toEqual([
		{ cocoaSeconds: 788918400, entries: [{ key: 'example.other', seconds: 30 }] }
	]);
	const emptySegment = scan();
	emptySegment.deviceActivityByDevice['device-1'][0].entries = [];
	await upload('2026-01-03/device-activity.tar.gz', emptySegment);
	merged = await readImportedScan(db);
	expect(merged.deviceActivityByDevice['device-1']).toEqual([
		{ cocoaSeconds: 788918400, entries: [] }
	]);
});

it('round-trips colliding daily and hourly segments and clears only the replaced granularity', async () => {
	const first = scan();
	first.deviceActivityByDevice['device-1'].push({
		cocoaSeconds: 788918400,
		hourly: true,
		entries: [{ key: 'web:example.test', seconds: 50 }]
	});
	await upload('2026-01-01/device-activity.tar.gz', first);
	let merged = await readImportedScan(db);
	expect(merged.deviceActivityByDevice['device-1']).toEqual([
		{ cocoaSeconds: 788918400, entries: [{ key: 'example.app', seconds: 60 }] },
		{
			cocoaSeconds: 788918400,
			hourly: true,
			entries: [{ key: 'web:example.test', seconds: 50 }]
		}
	]);

	const replacement = scan();
	replacement.deviceActivityByDevice['device-1'] = [
		{ cocoaSeconds: 788918400, hourly: true, entries: [] }
	];
	await upload('2026-01-02/device-activity.tar.gz', replacement);
	merged = await readImportedScan(db);
	expect(merged.deviceActivityByDevice['device-1']).toEqual([
		{ cocoaSeconds: 788918400, entries: [{ key: 'example.app', seconds: 60 }] },
		{ cocoaSeconds: 788918400, hourly: true, entries: [] }
	]);
});

it('reaps expired unreferenced uploads with cascading chunks and records while protecting current and progressing uploads', async () => {
	const current = await upload();
	const abandoned = await begin('2026-01-02/knowledgeC.db.gz');
	const progressing = await begin('2026-01-03/knowledgeC.db.gz');
	const conflicted = await begin(path, 'b'.repeat(64));
	for (const id of [abandoned, progressing, conflicted]) expect((await chunk(id)).status).toBe(204);
	const replacement = await begin(path, 'c'.repeat(64));
	expect((await chunk(replacement)).status).toBe(204);
	expect((await complete(replacement)).status).toBe(204);
	expect((await complete(conflicted)).status).toBe(409);
	sqlite.run(
		"UPDATE import_uploads SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days')"
	);
	// Retransmitting a successfully uploaded chunk is valid progress too.
	expect((await chunk(progressing)).status).toBe(204);
	await begin('2026-01-04/knowledgeC.db.gz');
	for (const id of [current, abandoned, conflicted]) {
		for (const table of ['import_uploads', 'import_chunks', 'import_records']) {
			const column = table === 'import_uploads' ? 'id' : 'upload_id';
			expect(
				sqlite.exec(`SELECT COUNT(*) FROM ${table} WHERE ${column} = '${id}'`)[0].values[0][0]
			).toBe(0);
		}
	}
	expect((await ledger()).files).toEqual([{ path, hash: 'c'.repeat(64), parserVersion: 1 }]);
	expect((await readImportedScan(db)).focusEventsByDevice['device-1']).toHaveLength(2);
	expect((await complete(progressing)).status).toBe(204);
	expect((await ledger()).files).toHaveLength(2);
});

it('does not renew expiration on conflicting or rolled-back chunks, and leaves recent stages alone', async () => {
	const conflicted = await begin();
	const failed = await begin('2026-01-02/knowledgeC.db.gz');
	expect((await chunk(conflicted)).status).toBe(204);
	sqlite.run(
		"UPDATE import_uploads SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days')"
	);
	expect((await chunk(conflicted, 0, scan(90))).status).toBe(409);
	sqlite.run(
		"CREATE TRIGGER fail_progress BEFORE UPDATE OF updated_at ON import_uploads BEGIN SELECT RAISE(ABORT, 'injected progress failure'); END"
	);
	await expect(chunk(failed)).rejects.toThrow('injected progress failure');
	sqlite.run('DROP TRIGGER fail_progress');
	const recent = await begin('2026-01-03/knowledgeC.db.gz');
	expect((await chunk(conflicted)).status).toBe(404);
	expect((await chunk(failed)).status).toBe(404);
	await begin('2026-01-04/knowledgeC.db.gz');
	expect((await chunk(recent)).status).toBe(204);
	expect((await complete(recent)).status).toBe(204);
});

it('bounds cleanup work per begin rather than sweeping the whole expired backlog', async () => {
	const id = await begin();
	sqlite.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<25)
 INSERT INTO import_uploads(id,path,hash,parser_version,time_zone,updated_at)
 SELECT 'expired-' || i,path,hash,parser_version,time_zone,strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days')
 FROM import_uploads,n WHERE id = '${id}'`);
	await begin();
	expect(
		sqlite.exec("SELECT COUNT(*) FROM import_uploads WHERE id LIKE 'expired-%'")[0].values[0][0]
	).toBe(15);
	await begin();
	expect(
		sqlite.exec("SELECT COUNT(*) FROM import_uploads WHERE id LIKE 'expired-%'")[0].values[0][0]
	).toBe(5);
});
