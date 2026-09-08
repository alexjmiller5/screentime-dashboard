// The dashboard's one read: the whole derived dataset from D1.
// ponytail: no authz here on purpose - Cloudflare Access gates every request
// before the Worker runs.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { readUsageCache } from '$lib/server/store';

export const GET: RequestHandler = async ({ platform }) => {
	const cache = await readUsageCache(platform!.env.DB);
	return cache ? json(cache) : new Response(null, { status: 404 });
};
