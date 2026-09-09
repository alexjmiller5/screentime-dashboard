import { describe, expect, it } from 'vitest';
import {
	clampWait,
	ingestStatements,
	insertStatements,
	refreshStatus,
	ROWS_PER_STATEMENT,
	STALE_RUN_MS
} from './store';

describe('insertStatements', () => {
	it('chunks rows so no statement exceeds D1 bound-parameter cap', () => {
		const rows = Array.from({ length: ROWS_PER_STATEMENT * 2 + 1 }, (_, i) => [i, 'x']);
		const stmts = insertStatements('t', ['a', 'b'], rows);
		expect(stmts).toHaveLength(3);
		expect(stmts[0].sql).toBe(
			`INSERT INTO t (a, b) VALUES ${Array(ROWS_PER_STATEMENT).fill('(?, ?)').join(', ')}`
		);
		expect(stmts[0].params).toHaveLength(ROWS_PER_STATEMENT * 2);
		expect(stmts[2].params).toEqual([ROWS_PER_STATEMENT * 2, 'x']);
	});

	it('appends the conflict clause verbatim and emits nothing for no rows', () => {
		expect(insertStatements('t', ['a'], [])).toEqual([]);
		const [s] = insertStatements('t', ['a'], [[1]], 'ON CONFLICT DO NOTHING');
		expect(s.sql).toBe('INSERT INTO t (a) VALUES (?) ON CONFLICT DO NOTHING');
	});
});

describe('refreshStatus', () => {
	const t0 = '2026-09-08T10:00:00.000Z';
	const t1 = '2026-09-08T10:01:00.000Z';
	const t2 = '2026-09-08T10:02:00.000Z';

	it('is idle with nothing requested, and pending once requested after the last import', () => {
		expect(refreshStatus({ imported_at: t0 })).toMatchObject({ pending: false, phase: 'idle' });
		expect(refreshStatus({ imported_at: t0, refresh_requested_at: t1 })).toMatchObject({
			pending: true,
			phase: 'requested'
		});
		expect(refreshStatus({ refresh_requested_at: t1 })).toMatchObject({ pending: true });
	});

	it('stops being pending once the run started, failed, or imported', () => {
		expect(
			refreshStatus({ refresh_requested_at: t1, refresh_started_at: t2 }, Date.parse(t2) + 1000)
		).toMatchObject({
			pending: false,
			phase: 'running'
		});
		expect(refreshStatus({ refresh_requested_at: t1, refresh_error: 'boom' })).toMatchObject({
			pending: false,
			phase: 'failed',
			error: 'boom'
		});
		expect(
			refreshStatus({ refresh_requested_at: t1, refresh_started_at: t1, imported_at: t2 })
		).toMatchObject({ pending: false, phase: 'idle' });
	});

	it('a new request after a failure or a stale start is pending again', () => {
		expect(
			refreshStatus({ refresh_requested_at: t2, refresh_started_at: t1, refresh_error: 'old' })
		).toMatchObject({ pending: true, phase: 'requested' });
	});
});

describe('ingestStatements', () => {
	it('a final chunk upserts rows under its run id, preserves older runs, stamps imported_at', () => {
		const stmts = ingestStatements(
			{
				runId: 'r2',
				timeZone: 'America/New_York',
				devices: { D1: 'iPhone' },
				rows: [{ source: 'infocus', device: 'D1', date: '2026-09-01', bundleId: 'a', seconds: 5 }],
				final: true
			},
			'2026-09-08T10:00:00.000Z'
		);
		const sqls = stmts.map((s) => s.sql);
		expect(sqls.some((sql) => sql.startsWith('DELETE FROM usage'))).toBe(false);
		expect(sqls.some((sql) => sql.startsWith('DELETE FROM hourly'))).toBe(false);
		expect(stmts.at(-1)).toEqual({
			sql: 'DELETE FROM meta WHERE key = ?',
			params: ['refresh_error']
		});
		expect(stmts.find((s) => s.params[0] === 'imported_at')?.params[1]).toBe(
			'2026-09-08T10:00:00.000Z'
		);
	});

	it('started clears the error; error records it; neither touches rows', () => {
		expect(ingestStatements({ runId: 'r', started: true }, 't').map((s) => s.params[0])).toEqual([
			'refresh_started_at',
			'refresh_error'
		]);
		expect(ingestStatements({ runId: 'r', error: 'nope' }, 't')).toEqual([
			{
				sql: 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
				params: ['refresh_error', 'nope']
			}
		]);
	});
});

describe('request kind + long-poll wait', () => {
	it('defaults the kind to dump and echoes a valid one', () => {
		expect(refreshStatus({ refresh_requested_at: 'x' }).kind).toBe('dump');
		expect(refreshStatus({ refresh_requested_at: 'x', refresh_kind: 'rebuild' }).kind).toBe(
			'rebuild'
		);
		expect(refreshStatus({ refresh_requested_at: 'x', refresh_kind: 'bogus' }).kind).toBe('dump');
	});
	it('clamps the wait to 0..30 whole seconds', () => {
		expect(clampWait(null)).toBe(0);
		expect(clampWait('abc')).toBe(0);
		expect(clampWait('-5')).toBe(0);
		expect(clampWait('12.9')).toBe(12);
		expect(clampWait('999')).toBe(30);
	});
});

describe('a run that never reports back', () => {
	const req = '2026-09-08T10:00:00.000Z';
	const started = '2026-09-08T10:00:05.000Z';
	const t0 = Date.parse(started);

	it('stays running inside the staleness window', () => {
		expect(
			refreshStatus({ refresh_requested_at: req, refresh_started_at: started }, t0 + 60_000)
		).toMatchObject({ pending: false, phase: 'running' });
	});

	it('becomes pending again once stale, so the retry path can pick it up', () => {
		expect(
			refreshStatus(
				{ refresh_requested_at: req, refresh_started_at: started },
				t0 + STALE_RUN_MS + 1
			)
		).toMatchObject({ pending: true, phase: 'requested' });
	});

	it('a finished or failed run never goes stale', () => {
		const late = t0 + STALE_RUN_MS * 10;
		expect(
			refreshStatus(
				{
					refresh_requested_at: req,
					refresh_started_at: started,
					imported_at: '2026-09-08T10:01:00.000Z'
				},
				late
			)
		).toMatchObject({ pending: false, phase: 'idle' });
		expect(
			refreshStatus(
				{ refresh_requested_at: req, refresh_started_at: started, refresh_error: 'nope' },
				late
			)
		).toMatchObject({ pending: false, phase: 'failed' });
	});
});
