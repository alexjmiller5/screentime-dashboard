// Refresh requests from the dashboard: POST flags one, GET reports where it is.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { metaStatements, readMeta, refreshStatus, runStatements } from '$lib/server/store';

export const GET: RequestHandler = async ({ platform }) => {
	return json(refreshStatus(await readMeta(platform!.env.DB)));
};

export const POST: RequestHandler = async ({ platform }) => {
	const db = platform!.env.DB;
	const status = refreshStatus(await readMeta(db));
	if (status.phase !== 'requested' && status.phase !== 'running') {
		await runStatements(db, metaStatements({ refresh_requested_at: new Date().toISOString() }));
	}
	return json(refreshStatus(await readMeta(db)));
};
