import { describe, expect, it } from 'vitest';
import {
	afterFailedAttempt,
	DashboardClient,
	planAttempt,
	planChunks,
	RETRY_DELAYS_MS,
	ROWS_PER_CHUNK
} from './client';
import type { UsageCache, UsageRow } from '../lib/data/cache';

const row = (i: number): UsageRow => ({
	source: 'infocus',
	device: 'D',
	date: '2026-09-01',
	bundleId: `app${i}`,
	seconds: i
});

describe('planChunks', () => {
	it('splits rows and hourly into bounded chunks and ends with one final chunk', () => {
		const cache: UsageCache = {
			version: 1,
			importedAt: 'x',
			timeZone: 'UTC',
			devices: { D: 'Mac' },
			rows: Array.from({ length: ROWS_PER_CHUNK + 1 }, (_, i) => row(i)),
			hourly: [{ device: 'D', date: '2026-09-01', hour: 1, bundleId: 'a', seconds: 2 }]
		};
		const chunks = planChunks(cache, 'run1');
		expect(chunks.map((c) => [c.rows?.length, c.hourly?.length, c.final])).toEqual([
			[ROWS_PER_CHUNK, undefined, undefined],
			[1, undefined, undefined],
			[undefined, 1, undefined],
			[undefined, undefined, true]
		]);
		expect(chunks.at(-1)).toMatchObject({ runId: 'run1', timeZone: 'UTC', devices: { D: 'Mac' } });
	});
});

describe('DashboardClient', () => {
	it('posts chunks with Access service-token headers and fails loudly on non-2xx', async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const fetchFn = (async (url: URL, init: RequestInit) => {
			calls.push({ url: url.toString(), init });
			return new Response(calls.length === 1 ? null : 'nope', {
				status: calls.length === 1 ? 204 : 403
			});
		}) as unknown as typeof fetch;
		const c = new DashboardClient(
			'https://dash.example',
			{ clientId: 'id', clientSecret: 'sec' },
			fetchFn
		);
		await c.post({ runId: 'r', started: true });
		expect(calls[0].url).toBe('https://dash.example/api/ingest');
		expect(calls[0].init.headers).toMatchObject({
			'CF-Access-Client-Id': 'id',
			'CF-Access-Client-Secret': 'sec'
		});
		expect(JSON.parse(calls[0].init.body as string)).toEqual({ runId: 'r', started: true });
		await expect(c.post({ runId: 'r' })).rejects.toThrow('ingest 403: nope');
	});

	it('pending reads the public flag, request id and kind, and passes the long-poll wait', async () => {
		let seen = '';
		let fetchFn = (async (u: URL) => {
			seen = u.toString();
			return Response.json({ pending: true, requestedAt: 'r1', kind: 'rebuild' });
		}) as unknown as typeof fetch;
		expect(await DashboardClient.pending('https://dash.example', fetchFn, 30)).toEqual({
			id: 'r1',
			kind: 'rebuild'
		});
		expect(seen).toBe('https://dash.example/api/refresh/pending?wait=30');
		fetchFn = (async () => Response.json({ pending: false })) as unknown as typeof fetch;
		expect(await DashboardClient.pending('https://dash.example', fetchFn)).toBeNull();
	});
});

describe('attempt planning', () => {
	const req = { id: 'r1', kind: 'dump' as const };
	it('attempts a new request at once, waits out the backoff, then gives up', () => {
		expect(planAttempt(req, null, 0)).toEqual({ action: 'attempt' });
		const s1 = afterFailedAttempt(req, null, 1000);
		expect(s1).toEqual({ id: 'r1', attempts: 1, nextAttemptAt: 1000 + RETRY_DELAYS_MS[0] });
		expect(planAttempt(req, s1, 2000)).toEqual({ action: 'wait', ms: RETRY_DELAYS_MS[0] - 1000 });
		expect(planAttempt(req, s1, s1.nextAttemptAt)).toEqual({ action: 'attempt' });
		let s = s1;
		for (let i = 1; i < RETRY_DELAYS_MS.length; i++)
			s = afterFailedAttempt(req, s, s.nextAttemptAt);
		expect(s.attempts).toBe(RETRY_DELAYS_MS.length);
		expect(planAttempt(req, s, s.nextAttemptAt)).toEqual({ action: 'attempt' });
		s = afterFailedAttempt(req, s, s.nextAttemptAt);
		expect(planAttempt(req, s, Number.MAX_SAFE_INTEGER)).toEqual({ action: 'exhausted' });
	});
	it('a different request resets the count', () => {
		const spent = { id: 'r1', attempts: 9, nextAttemptAt: Infinity };
		expect(planAttempt({ id: 'r2', kind: 'dump' }, spent, 0)).toEqual({ action: 'attempt' });
		expect(afterFailedAttempt({ id: 'r2', kind: 'dump' }, spent, 0).attempts).toBe(1);
	});
});
