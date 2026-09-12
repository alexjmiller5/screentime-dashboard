import { describe, expect, it } from 'vitest';
import {
	afterFailedAttempt,
	DashboardClient,
	planAttempt,
	RETRY_DELAYS_MS,
	authenticatedFetch
} from './client';
describe('DashboardClient', () => {
	it('uses the app device endpoint for bearer auth and never sends it to another origin', async () => {
		const calls: Request[] = [];
		const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push(new Request(input, init));
			return new Response(null, { status: 204 });
		}) as typeof fetch;
		const credential = { token: `st_${'a'.repeat(64)}`, headers: { 'X-Proxy': 'proxy-value' } };
		const client = new DashboardClient('https://dash.example', credential, fetchFn);
		await client.post({ runId: 'run', started: true });
		const upload = authenticatedFetch('https://dash.example', credential, fetchFn);
		await upload('https://dash.example/api/imports', {
			method: 'POST',
			body: '{"action":"begin"}'
		});
		expect(calls.map((r) => r.url)).toEqual([
			'https://dash.example/api/device/ingest',
			'https://dash.example/api/device/imports'
		]);
		expect(calls[0].headers.get('Authorization')).toBe(`Bearer ${credential.token}`);
		expect(calls[0].headers.has('CF-Access-Client-Secret')).toBe(false);
		expect(calls[0].headers.get('X-Proxy')).toBe('proxy-value');
		expect(calls[0].redirect).toBe('error');
		expect(await calls[1].json()).toEqual({ action: 'begin' });
		await expect(upload('https://elsewhere.example/api/imports')).rejects.toThrow('origin');
		expect(calls).toHaveLength(2);
	});
	it('posts chunks with Access service-token headers and fails loudly on non-2xx', async () => {
		const calls: Request[] = [];
		const fetchFn = (async (url: Request, init: RequestInit) => {
			calls.push(new Request(url, init));
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
		expect(calls[0].headers.get('CF-Access-Client-Id')).toBe('id');
		expect(calls[0].headers.get('CF-Access-Client-Secret')).toBe('sec');
		expect(await calls[0].json()).toEqual({ runId: 'r', started: true });
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
