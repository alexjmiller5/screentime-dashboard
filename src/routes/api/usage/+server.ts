// Access protects this route before the Worker runs. Cache only the derived
// representation for the current data version; every import invalidates it.
// ponytail: derive the full history on a cache miss; partition by month if
// unique events no longer fit the Worker memory budget.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { readMeta, readUsageCache } from '$lib/server/store';
import type { FocusSession } from '$lib/data/cache';

export const GET: RequestHandler = async ({ platform, url }) => {
	const timing = url.searchParams.get('sessions') === '1';
	const start = url.searchParams.get('start') ?? '';
	const end = url.searchParams.get('end') ?? '';
	const validDate = (date: string) =>
		/^\d{4}-\d{2}-\d{2}$/.test(date) &&
		Number.isFinite(Date.parse(date)) &&
		new Date(date).toISOString().slice(0, 10) === date;
	if (timing && (!validDate(start) || !validDate(end) || start > end))
		return json({ error: 'Choose a valid start and end date.' }, { status: 400 });
	const meta = await readMeta(platform!.env.DB);
	const version = meta.data_updated_at ?? meta.imported_at;
	const cache =
		typeof caches === 'undefined'
			? undefined
			: await caches
					.open(timing ? 'screentime-sessions-v1' : 'screentime-summary-v2')
					.catch(() => undefined);
	const keyUrl = new URL('/api/usage', url);
	keyUrl.searchParams.set('version', version ?? 'empty');
	const key = new Request(keyUrl);
	let response = version ? await cache?.match(key).catch(() => undefined) : undefined;
	if (!response) {
		const data = await readUsageCache(platform!.env.DB);
		if (!data) return new Response(null, { status: 404 });
		response = json(
			timing
				? { sessions: data.sessions ?? [], importedAt: data.importedAt }
				: { ...data, sessions: undefined },
			{ headers: { 'cache-control': 'public, max-age=86400' } }
		);
		if (version) await cache?.put(key, response.clone()).catch(() => {});
	}
	if (timing) {
		const data = (await response.json()) as { sessions: FocusSession[]; importedAt: string };
		// One day on either side covers all IANA UTC offsets; the client clips
		// the returned sessions to exact local dates and clock-hour boundaries.
		const min = Date.parse(start) - 86_400_000;
		const max = Date.parse(end) + 2 * 86_400_000;
		return json(
			{ ...data, sessions: data.sessions.filter((s) => s.endMs > min && s.startMs < max) },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	}
	const result = new Response(response.body, response);
	result.headers.set('cache-control', 'private, no-store');
	return result;
};
