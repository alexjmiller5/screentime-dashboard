import { describe, expect, it } from 'vitest';
import { DashboardClient, planChunks, ROWS_PER_CHUNK } from './client';
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

	it('pending reads the public flag', async () => {
		const fetchFn = (async () => Response.json({ pending: true })) as unknown as typeof fetch;
		expect(await DashboardClient.pending('https://dash.example', fetchFn)).toBe(true);
	});
});
