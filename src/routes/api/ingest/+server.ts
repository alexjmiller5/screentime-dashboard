// Ingest endpoint for the screentime-ingest job (mac mini): chunked rows,
// run start/error markers, and the final sweep. Reached through Cloudflare
// Access with a service token, so no app-level auth.

import type { RequestHandler } from '@sveltejs/kit';
import { ingestStatements, runStatements, type IngestChunk } from '$lib/server/store';

const MAX_BYTES = 8 * 1024 * 1024;

export const POST: RequestHandler = async ({ platform, request }) => {
	const body = await request.text();
	if (body.length > MAX_BYTES) return new Response('chunk too large', { status: 413 });
	let chunk: IngestChunk;
	try {
		chunk = JSON.parse(body) as IngestChunk;
	} catch {
		return new Response('not json', { status: 400 });
	}
	if (!chunk || typeof chunk !== 'object') return new Response('object required', { status: 400 });
	if (chunk.rows || chunk.hourly || chunk.devices)
		return new Response('Use the file import API; update the ingest client', { status: 409 });
	if (typeof chunk.runId !== 'string' || !chunk.runId) {
		return new Response('runId required', { status: 400 });
	}
	await runStatements(platform!.env.DB, ingestStatements(chunk, new Date().toISOString()));
	return new Response(null, { status: 204 });
};
