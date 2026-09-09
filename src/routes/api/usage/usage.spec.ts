import { afterEach, expect, it, vi } from 'vitest';
import { GET } from './+server';
const state = vi.hoisted(() => ({ version: 'first', reads: 0 }));
vi.mock('$lib/server/store', () => ({
	readMeta: async () => ({ data_updated_at: state.version }),
	readUsageCache: async () => {
		state.reads++;
		return { importedAt: state.version, rows: [] };
	}
}));
afterEach(() => vi.unstubAllGlobals());
it('reuses derived results until data changes and keeps client responses private', async () => {
	const entries = new Map<string, Response>();
	vi.stubGlobal('caches', {
		open: async () => ({
			match: async (key: Request) => entries.get(key.url)?.clone(),
			put: async (key: Request, res: Response) => {
				entries.set(key.url, res.clone());
			}
		})
	});
	const event = {
		platform: { env: { DB: {} } },
		url: new URL('https://example.com/api/usage')
	} as Parameters<typeof GET>[0];
	const first = await GET(event);
	expect(first.headers.get('cache-control')).toContain('private');
	await GET(event);
	expect(state.reads).toBe(1);
	state.version = 'second';
	expect(await (await GET(event)).json()).toMatchObject({ importedAt: 'second' });
	expect(state.reads).toBe(2);
});
