// Refresh requests from the dashboard: POST flags one, GET reports where it is.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import {
	isRefreshKind,
	metaStatements,
	readMeta,
	refreshStatus,
	runStatements
} from '$lib/server/store';

export const GET: RequestHandler = async ({ platform }) => {
	return json(refreshStatus(await readMeta(platform!.env.DB)));
};

export const POST: RequestHandler = async ({ platform, request }) => {
	const db = platform!.env.DB;
	const body = (await request.json().catch(() => ({}))) as { kind?: unknown };
	const kind = isRefreshKind(body.kind) ? body.kind : 'dump';
	const status = refreshStatus(await readMeta(db));
	if (status.phase !== 'running') {
		await runStatements(
			db,
			metaStatements({
				refresh_requested_at: new Date().toISOString(),
				refresh_kind: kind,
				refresh_error: undefined
			})
		);
	}
	return json(refreshStatus(await readMeta(db)));
};
