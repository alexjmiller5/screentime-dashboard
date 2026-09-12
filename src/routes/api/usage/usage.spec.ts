import { afterEach, expect, it, vi } from 'vitest';
import { GET } from './+server';
const state = vi.hoisted(() => ({ version: 'first', reads: 0 }));
vi.mock('$lib/server/store', () => ({
	readMeta: async () => ({ data_updated_at: state.version }),
	readUsageCache: async () => {
		state.reads++;
		return {
			importedAt: state.version,
			rows: [],
			sessions: [
				{
					device: 'phone',
					bundleId: 'app',
					startMs: Date.parse('2026-03-01T09:00:00Z'),
					endMs: Date.parse('2026-03-01T10:00:00Z')
				},
				{
					device: 'phone',
					bundleId: 'old',
					startMs: Date.parse('2026-01-01T09:00:00Z'),
					endMs: Date.parse('2026-01-01T10:00:00Z')
				}
			]
		};
	}
}));
afterEach(() => vi.unstubAllGlobals());
it('reuses derived results until data changes and keeps client responses private', async () => {
	const entries = new Map<string, Response>();
	const namespaces = new Set<string>();
	vi.stubGlobal('caches', {
		open: async (name: string) => {
			namespaces.add(name);
			return {
				match: async (key: Request) => entries.get(key.url)?.clone(),
				put: async (key: Request, res: Response) => {
					entries.set(key.url, res.clone());
				}
			};
		}
	});
	const event = {
		platform: { env: { DB: {} } },
		url: new URL('https://example.com/api/usage')
	} as Parameters<typeof GET>[0];
	const first = await GET(event);
	expect(first.headers.get('cache-control')).toContain('private');
	const summary = await first.json();
	expect(summary).not.toHaveProperty('sessions');
	await GET(event);
	expect(state.reads).toBe(1);
	state.version = 'second';
	expect(await (await GET(event)).json()).toMatchObject({ importedAt: 'second' });
	expect(state.reads).toBe(2);
	expect([...namespaces]).toEqual(['screentime-summary-v3']);
});

it('serves timing detail even when a pre-session response is cached for the same import', async () => {
	const namespaces: string[] = [];
	vi.stubGlobal('caches', {
		open: async (name: string) => ({
			match: async () => {
				namespaces.push(name);
				return undefined;
			},
			put: async () => {}
		})
	});
	const response = await GET({
		platform: { env: { DB: {} } },
		url: new URL('https://example.com/api/usage?sessions=1&start=2026-03-01&end=2026-03-01')
	} as Parameters<typeof GET>[0]);
	const detail = (await response.json()) as { sessions: { bundleId: string }[] };
	expect(detail.sessions.map((s: { bundleId: string }) => s.bundleId)).toEqual(['app']);
	expect(detail).not.toHaveProperty('rows');
	expect(namespaces).toEqual(['screentime-sessions-v1']);
});

it.each([
	'start=bad&end=2026-03-01',
	'start=2026-03-02&end=2026-03-01',
	'start=2026-02-30&end=2026-03-01'
])('rejects invalid timeline ranges: %s', async (query) => {
	const response = await GET({
		platform: { env: { DB: {} } },
		url: new URL(`https://example.com/api/usage?sessions=1&${query}`)
	} as Parameters<typeof GET>[0]);
	expect(response.status).toBe(400);
});
