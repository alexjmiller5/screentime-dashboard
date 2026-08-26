// The whole backend: one R2 object in, one R2 object out.
// ponytail: the '{' sniff is a shape check, not authz - Cloudflare Access
// gates every request before the Worker runs.

import type { RequestHandler } from '@sveltejs/kit';

const KEY = 'usage-cache.json';
const MAX_BYTES = 50 * 1024 * 1024;

export const GET: RequestHandler = async ({ platform }) => {
	const object = await platform!.env.CACHE.get(KEY);
	if (!object) return new Response(null, { status: 404 });
	return new Response(object.body as BodyInit, {
		headers: { 'content-type': 'application/json' }
	});
};

export const PUT: RequestHandler = async ({ platform, request }) => {
	const body = await request.text();
	if (!body.startsWith('{') || body.length < 10 || body.length > MAX_BYTES) {
		return new Response('not a usage cache document', { status: 400 });
	}
	await platform!.env.CACHE.put(KEY, body);
	return new Response(null, { status: 204 });
};
