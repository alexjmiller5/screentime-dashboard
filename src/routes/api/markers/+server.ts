import { json, type RequestHandler } from '@sveltejs/kit';
import { parseMarker, type Marker, type MarkerInput } from '$lib/viz/markers';

const headers = { 'cache-control': 'no-store' };
const badRequest = (message: string) => json({ error: message }, { status: 400, headers });
const validId = (id: unknown): id is string =>
	typeof id === 'string' &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export const GET: RequestHandler = async ({ platform }) => {
	const { results } = await platform!.env.DB.prepare(
		'SELECT id, date, title FROM markers ORDER BY date, title, id'
	).all<Marker>();
	return json({ markers: results }, { headers });
};

export const POST: RequestHandler = async ({ platform, request }) => {
	let input: MarkerInput;
	try {
		input = parseMarker(await request.json());
	} catch (e) {
		return badRequest(e instanceof SyntaxError ? 'Invalid JSON.' : (e as Error).message);
	}
	const marker = { id: crypto.randomUUID(), ...input };
	await platform!.env.DB.prepare('INSERT INTO markers (id, date, title) VALUES (?, ?, ?)')
		.bind(marker.id, marker.date, marker.title)
		.run();
	return json(marker, { status: 201, headers });
};

export const PUT: RequestHandler = async ({ platform, request }) => {
	let input: MarkerInput;
	let id: unknown;
	try {
		const body = await request.json();
		input = parseMarker(body);
		id = (body as Record<string, unknown>).id;
	} catch (e) {
		return badRequest(e instanceof SyntaxError ? 'Invalid JSON.' : (e as Error).message);
	}
	if (!validId(id)) return badRequest('Provide a valid marker id.');
	const marker = await platform!.env.DB.prepare(
		'UPDATE markers SET date = ?, title = ? WHERE id = ? RETURNING id, date, title'
	)
		.bind(input.date, input.title, id)
		.first<Marker>();
	return marker
		? json(marker, { headers })
		: json({ error: 'Marker not found.' }, { status: 404, headers });
};

export const DELETE: RequestHandler = async ({ platform, url }) => {
	const id = url.searchParams.get('id');
	if (!validId(id)) return badRequest('Provide a valid marker id.');
	const { meta } = await platform!.env.DB.prepare('DELETE FROM markers WHERE id = ?')
		.bind(id)
		.run();
	return meta.changes
		? new Response(null, { status: 204, headers })
		: json({ error: 'Marker not found.' }, { status: 404, headers });
};
