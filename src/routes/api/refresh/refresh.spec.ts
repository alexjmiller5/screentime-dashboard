import { expect, it, vi } from 'vitest';
import { POST } from './+server';
import type { Meta, Statement } from '$lib/server/store';

const { meta } = vi.hoisted(() => ({ meta: {} as Meta }));
vi.mock('$lib/server/store', async (original) => ({
	...(await original<typeof import('$lib/server/store')>()),
	readMeta: async () => meta,
	runStatements: async (_db: unknown, statements: Statement[]) => {
		for (const { params } of statements) {
			const key = params[0] as keyof Meta;
			if (params.length === 1) delete meta[key];
			else meta[key] = params[1] as string;
		}
	}
}));

it('a new Refresh clears a credential failure recorded before the run started', async () => {
	Object.assign(meta, {
		refresh_requested_at: '2026-01-01T00:00:00.000Z',
		refresh_error: 'credential unavailable'
	});
	const response = await POST({
		platform: { env: { DB: {} } },
		request: new Request('https://example.com/api/refresh', {
			method: 'POST',
			body: JSON.stringify({ kind: 'dump' })
		})
	} as Parameters<typeof POST>[0]);
	expect(await response.json()).toMatchObject({ pending: true, phase: 'requested' });
	expect(meta.refresh_error).toBeUndefined();
});
