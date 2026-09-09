// Access protects this route before the Worker runs. Cache only the derived
// representation for the current data version; every import invalidates it.
// ponytail: derive the full history on a cache miss; partition by month if
// unique events no longer fit the Worker memory budget.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { readMeta, readUsageCache } from '$lib/server/store';

export const GET: RequestHandler = async ({ platform, url }) => {
	const meta = await readMeta(platform!.env.DB);
	const version = meta.data_updated_at ?? meta.imported_at;
	const cache =
		typeof caches === 'undefined'
			? undefined
			: await caches.open('screentime-usage').catch(() => undefined);
	const keyUrl = new URL('/api/usage', url);
	keyUrl.searchParams.set('version', version ?? 'empty');
	const key = new Request(keyUrl);
	let response = version ? await cache?.match(key).catch(() => undefined) : undefined;
	if (!response) {
		const data = await readUsageCache(platform!.env.DB);
		if (!data) return new Response(null, { status: 404 });
		response = json(data, { headers: { 'cache-control': 'public, max-age=86400' } });
		if (version) await cache?.put(key, response.clone()).catch(() => {});
	}
	const result = new Response(response.body, response);
	result.headers.set('cache-control', 'private, no-store');
	return result;
};
