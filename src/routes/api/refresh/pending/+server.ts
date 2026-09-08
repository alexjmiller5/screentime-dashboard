// Polled by the ingest job without credentials (Access bypasses this path):
// a bare "is a refresh waiting" flag leaks nothing about the data.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { readMeta, refreshStatus } from '$lib/server/store';

export const GET: RequestHandler = async ({ platform }) => {
	const { pending, requestedAt } = refreshStatus(await readMeta(platform!.env.DB));
	return json(
		pending ? { pending, requestedAt } : { pending },
		{ headers: { 'cache-control': 'no-store' } }
	);
};
