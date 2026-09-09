import initSqlJs, { type Database, type SqlValue } from 'sql.js';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { GET, POST } from './+server';
import { POST as report } from './job/+server';
import type { RefreshStatus } from '$lib/server/store';

let sqlite: Database;
let db: D1Database;
beforeEach(async () => {
	const SQL = await initSqlJs();
	sqlite = new SQL.Database();
	sqlite.run('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
	const prepare = (sql: string, params: SqlValue[] = []): unknown => {
		const execute = () => {
			const stmt = sqlite.prepare(sql);
			try {
				stmt.bind(params);
				const results = [];
				while (stmt.step()) results.push(stmt.getAsObject());
				return { results, meta: { changes: sqlite.getRowsModified() } };
			} finally {
				stmt.free();
			}
		};
		return {
			bind: (...values: SqlValue[]) => prepare(sql, values),
			run: async () => execute(),
			all: async () => execute(),
			first: async () => execute().results[0] ?? null
		};
	};
	db = { prepare } as D1Database;
});
afterEach(() => sqlite.close());
const event = (body?: unknown) =>
	({
		platform: { env: { DB: db } },
		request: new Request('https://example.com/api/refresh', {
			method: 'POST',
			body: JSON.stringify(body ?? {})
		})
	}) as Parameters<typeof POST>[0];

it('two tabs join one job, read confirmed stages, and recover completion on reopening', async () => {
	const [first, second] = await Promise.all([POST(event()), POST(event())]);
	const one = (await first.json()) as RefreshStatus;
	expect(await second.json()).toEqual(one);
	const context = { requestId: one.requestId, runId: 'attempt-1' };
	expect((await report(event({ ...context, stage: 'accepted' }))).status).toBe(200);
	expect((await report(event({ ...context, stage: 'copying' }))).status).toBe(200);
	expect(await (await GET(event())).json()).toMatchObject({ stage: 'copying', confirmed: true });
	expect(await (await POST(event())).json()).toMatchObject({
		requestId: one.requestId,
		stage: 'copying'
	});
	expect(
		(await report(event({ ...context, stage: 'importing', detail: '2 imported, 1 skipped' })))
			.status
	).toBe(200);
	// A stale watcher cannot overwrite import progress or fake its heartbeat.
	expect((await report(event({ ...context, stage: 'heartbeat' }))).status).toBe(409);
	expect((await report(event({ ...context, stage: 'complete' }))).status).toBe(200);
	expect(await (await GET(event())).json()).toMatchObject({
		stage: 'complete',
		detail: '2 imported, 1 skipped'
	});
	const next = (await (await POST(event())).json()) as RefreshStatus;
	expect(next.requestId).not.toBe(one.requestId);
	expect((await report(event({ ...context, stage: 'complete' }))).status).toBe(409);
	expect((await GET(event())).headers.get('cache-control')).toBe('no-store');
});

it('validates progress writes and only one concurrent attempt can claim a request', async () => {
	const job = (await (await POST(event())).json()) as RefreshStatus;
	const responses = await Promise.all(
		['a', 'b'].map((runId) => report(event({ requestId: job.requestId, runId, stage: 'accepted' })))
	);
	expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
	expect(
		(await report(event({ requestId: job.requestId, runId: 'a', stage: 'unknown' }))).status
	).toBe(400);
	expect(
		(await report(event({ requestId: job.requestId, runId: 'a', stage: 'retrying' }))).status
	).toBe(400);
});
