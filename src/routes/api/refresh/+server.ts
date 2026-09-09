// A refresh belongs to the service, not the tab that requested it.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { isRefreshKind, readMeta, refreshStatus } from '$lib/server/store';
import { newJob, readJob, writeJob, jobStatus } from '$lib/server/refresh-job';

export const GET: RequestHandler = async ({ platform }) =>
	json(refreshStatus(await readMeta(platform!.env.DB)), {
		headers: { 'cache-control': 'no-store' }
	});

export const POST: RequestHandler = async ({ platform, request }) => {
	const db = platform!.env.DB;
	const body = (await request.json().catch(() => ({}))) as {
		kind?: unknown;
		retry?: unknown;
	} | null;
	const kind = isRefreshKind(body?.kind) ? body.kind : 'dump';
	const previous = await readJob(db);
	// Repeated clicks join the active job. An explicit retry can replace a
	// failed job or an unacknowledged request after the mini stopped responding.
	const replace =
		!previous ||
		previous.stage === 'complete' ||
		previous.stage === 'failed' ||
		(body?.retry === true &&
			(previous.stage === 'retrying' ||
				(previous.stage === 'requested' &&
					Date.now() - Date.parse(previous.requestedAt) > 60_000) ||
				(jobStatus(previous, Date.now()).pending && previous.stage !== 'requested')));
	if (replace)
		await writeJob(db, previous, newJob(crypto.randomUUID(), kind, new Date().toISOString()));
	return json(jobStatus((await readJob(db))!, Date.now()), {
		headers: { 'cache-control': 'no-store' }
	});
};
