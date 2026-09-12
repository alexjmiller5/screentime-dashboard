import type { RequestHandler } from './$types';
import { authenticateUploadDevice, revokeUploadDevice } from '$lib/server/device-auth';
import { GET as importsGET, POST as importsPOST } from '../../imports/+server';
import { POST as ingestPOST } from '../../ingest/+server';
import { GET as refreshGET } from '../../refresh/+server';
import { POST as refreshJobPOST } from '../../refresh/job/+server';

const ALLOWED = new Map<string, RequestHandler>([
	['GET imports', importsGET],
	['POST imports', importsPOST],
	['POST ingest', ingestPOST],
	['GET refresh', refreshGET],
	['POST refresh/job', refreshJobPOST]
]);
const KNOWN_PATHS = new Set(['session', 'imports', 'ingest', 'refresh', 'refresh/job']);

function response(body: BodyInit | null, status = 200, contentType?: string): Response {
	return new Response(body, {
		status,
		headers: {
			'Cache-Control': 'no-store',
			...(contentType ? { 'Content-Type': contentType } : {})
		}
	});
}

function json(value: unknown, status = 200): Response {
	return response(JSON.stringify(value), status, 'application/json');
}

function noStore(upstream: Response): Response {
	if (upstream.status >= 300 && upstream.status < 400)
		return response('Redirect blocked', 502, 'text/plain; charset=utf-8');
	const result = new Response(upstream.body, upstream);
	result.headers.set('Cache-Control', 'no-store');
	return result;
}

const handle: RequestHandler = async (event) => {
	const db = event.platform!.env.DB;
	const device = await authenticateUploadDevice(db, event.request);
	if (!device) return json({ error: 'Invalid or revoked device token' }, 401);
	const path = event.params.path ?? '';
	if (path === 'session') {
		if (event.request.method === 'GET') return json({ scope: 'ingest' });
		if (event.request.method === 'DELETE') {
			await revokeUploadDevice(db, device.hash);
			return response(null, 204);
		}
		return response('Method not allowed', 405, 'text/plain; charset=utf-8');
	}
	const handler = ALLOWED.get(`${event.request.method} ${path}`);
	if (!handler)
		return response(
			KNOWN_PATHS.has(path) ? 'Method not allowed' : 'Not found',
			KNOWN_PATHS.has(path) ? 405 : 404,
			'text/plain; charset=utf-8'
		);
	return noStore(await handler(event));
};

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const fallback = handle;
