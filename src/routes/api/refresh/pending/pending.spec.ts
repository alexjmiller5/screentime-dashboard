import { expect, it, vi } from 'vitest';
import { GET } from './+server';
vi.mock('$lib/server/store', async (original) => ({
	...(await original<typeof import('$lib/server/store')>()),
	readMeta: async () => ({
		refresh_requested_at: '2026-01-01T00:00:00.000Z',
		refresh_started_at: '2026-01-01T00:00:01.000Z',
		refresh_error: 'failed'
	})
}));
it('keeps a failed request eligible for the daemon bounded retry without publishing its error', async () => {
	const res = await GET({
		platform: { env: { DB: {} } },
		url: new URL('https://example.com/api/refresh/pending')
	} as Parameters<typeof GET>[0]);
	expect(await res.json()).toEqual({
		pending: true,
		requestedAt: '2026-01-01T00:00:00.000Z',
		kind: 'dump'
	});
});
