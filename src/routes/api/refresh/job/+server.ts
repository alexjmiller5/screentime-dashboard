// Access protects all job writes; the public pending endpoint remains read-only.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { readJob, updateJob, validJobUpdate, writeJob } from '$lib/server/refresh-job';

export const POST: RequestHandler = async ({ platform, request }) => {
	const raw = await request.text();
	if (raw.length > 4096) return new Response('Update too large', { status: 413 });
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		return new Response('Invalid JSON', { status: 400 });
	}
	if (!validJobUpdate(body)) return new Response('Invalid job update', { status: 400 });
	const db = platform!.env.DB;
	// A heartbeat can race a stage transition. Retry the CAS against the new
	// value; updateJob still rejects stale attempts and backwards transitions.
	for (let attempt = 0; attempt < 3; attempt++) {
		const previous = await readJob(db);
		const next = previous && updateJob(previous, body, new Date().toISOString());
		if (!next) break;
		if (await writeJob(db, previous, next))
			return json(next, { headers: { 'cache-control': 'no-store' } });
	}
	return new Response('Job changed or attempt is no longer active', { status: 409 });
};
