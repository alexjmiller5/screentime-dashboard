import { json, type RequestHandler } from '@sveltejs/kit';
import {
	ImportError,
	importAction,
	MAX_IMPORT_BYTES,
	readImportLedger
} from '$lib/server/incremental';

export const GET: RequestHandler = async ({ platform }) =>
	json(await readImportLedger(platform!.env.DB), { headers: { 'cache-control': 'no-store' } });

export const POST: RequestHandler = async ({ platform, request }) => {
	try {
		// Bound bytes while reading, including chunked requests without Content-Length.
		const reader = request.body?.getReader();
		if (!reader) throw new ImportError(400, 'JSON body required');
		const decoder = new TextDecoder('utf-8', { fatal: true });
		let bytes = 0;
		let body = '';
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > MAX_IMPORT_BYTES) {
					await reader.cancel();
					throw new ImportError(413, 'chunk too large');
				}
				body += decoder.decode(value, { stream: true });
			}
			body += decoder.decode();
		} catch (error) {
			if (error instanceof ImportError) throw error;
			throw new ImportError(400, 'invalid request body');
		} finally {
			reader.releaseLock();
		}
		let input: unknown;
		try {
			input = JSON.parse(body);
		} catch {
			throw new ImportError(400, 'not JSON');
		}
		const result = await importAction(platform!.env.DB, input);
		return result ? json(result) : new Response(null, { status: 204 });
	} catch (error) {
		if (error instanceof ImportError) return new Response(error.message, { status: error.status });
		throw error;
	}
};
