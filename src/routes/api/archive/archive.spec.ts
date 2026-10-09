import { expect, it, vi } from 'vitest';
import { GET, POST } from './+server';
vi.mock('$env/dynamic/private', () => ({ env: {} }));
const event = (url = 'https://dashboard.example/api/archive', init: RequestInit = {}, env = {}) =>
	({
		url: new URL(url),
		request: new Request(url, init),
		platform: { env },
		fetch: vi.fn()
	}) as any;
it('leaves an unconfigured local-only installation explicit and never attempts a service call', async () => {
	const e = event();
	expect(await (await GET(e)).json()).toEqual({ enabled: false });
	expect(e.fetch).not.toHaveBeenCalled();
});
it('fails on incomplete archive setup instead of silently importing without retention', async () => {
	const e = event(undefined, {}, { SOMA_HUB_URL: 'https://hub.example' });
	await expect(GET(e)).rejects.toMatchObject({ status: 503 });
	expect(e.fetch).not.toHaveBeenCalled();
});
it('rejects cross-origin and malformed upload requests before accessing data', async () => {
	await expect(
		POST(event(undefined, { method: 'POST', headers: { origin: 'https://foreign.example' } }))
	).rejects.toMatchObject({ status: 403 });
	await expect(POST(event(undefined, { method: 'POST' }))).rejects.toMatchObject({ status: 400 });
});
it('a disabled archive cannot accept bytes through the upload endpoint', async () => {
	await expect(
		POST(
			event('https://dashboard.example/api/archive?file=2030-01-01/knowledgeC.db.gz', {
				method: 'POST',
				headers: { 'content-type': 'application/octet-stream', 'x-archive-expected': 'new' },
				body: 'source'
			})
		)
	).rejects.toMatchObject({ status: 503 });
});
