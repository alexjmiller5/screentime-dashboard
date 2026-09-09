// Polled by the ingest job without credentials (Access bypasses this path):
// a bare "is a refresh waiting" flag leaks nothing about the data. `?wait=N`
// long-polls: the request is held up to N seconds (max 30) and answers the
// moment a request lands, so the job picks it up near-instantly at the same
// request rate as a plain 30s poll.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { clampWait, readMeta, refreshStatus } from '$lib/server/store';

const POLL_MS = 1000;

export const GET: RequestHandler = async ({ platform, url }) => {
	const db = platform!.env.DB;
	const deadline = Date.now() + clampWait(url.searchParams.get('wait')) * 1000;
	for (;;) {
		const status = refreshStatus(await readMeta(db));
		const { requestedAt, kind } = status;
		const pending = status.pending || (!status.stage && status.phase === 'failed');
		if (pending || Date.now() >= deadline) {
			return json(
				pending
					? { pending, requestedAt, kind, ...(status.requestId ? { id: status.requestId } : {}) }
					: { pending },
				{
					headers: { 'cache-control': 'no-store' }
				}
			);
		}
		await new Promise((r) => setTimeout(r, Math.min(POLL_MS, deadline - Date.now())));
	}
};
