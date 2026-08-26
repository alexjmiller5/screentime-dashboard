import { describe, expect, it } from 'vitest';
import { GET, PUT } from './+server';

type StoredValue = string | null;

function fakePlatform(initial: StoredValue = null) {
	const store = new Map<string, string>();
	if (initial !== null) store.set('usage-cache.json', initial);
	const CACHE = {
		get: async (key: string) => {
			const value = store.get(key);
			return value === undefined ? null : { text: async () => value, body: value };
		},
		put: async (key: string, value: string) => {
			store.set(key, value);
		}
	};
	return { platform: { env: { CACHE } } as unknown as App.Platform, store };
}

const req = (body: string): Request =>
	new Request('http://localhost/api/usage', { method: 'PUT', body });

describe('GET /api/usage', () => {
	it('404s when nothing has been imported yet', async () => {
		const { platform } = fakePlatform();
		// @ts-expect-error minimal event
		const res = await GET({ platform });
		expect(res.status).toBe(404);
	});

	it('serves the stored cache as JSON', async () => {
		const doc = '{"version":1,"rows":[]}';
		const { platform } = fakePlatform(doc);
		// @ts-expect-error minimal event
		const res = await GET({ platform });
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('application/json');
		expect(await res.text()).toBe(doc);
	});
});

describe('PUT /api/usage', () => {
	it('stores a JSON document', async () => {
		const { platform, store } = fakePlatform();
		const doc = '{"version":1,"rows":[{"seconds":60}]}';
		// @ts-expect-error minimal event
		const res = await PUT({ platform, request: req(doc) });
		expect(res.status).toBe(204);
		expect(store.get('usage-cache.json')).toBe(doc);
	});

	it('rejects non-JSON-shaped bodies', async () => {
		const { platform, store } = fakePlatform();
		// @ts-expect-error minimal event
		const res = await PUT({ platform, request: req('hello') });
		expect(res.status).toBe(400);
		expect(store.size).toBe(0);
	});
});
