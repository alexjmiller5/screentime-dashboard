import { error, json, type RequestHandler } from '@sveltejs/kit';
import { env as privateEnv } from '$env/dynamic/private';
import { ArchiveSource, archiveHeadStore } from '$lib/server/archive-source';
import { SomaArchive, boundedBytes } from '$lib/server/archive';
import { parseArchiveManifest } from '$lib/import/archive';
function configured(platform: App.Platform | undefined, fetchFn: typeof fetch) {
	const env = { ...privateEnv, ...platform?.env } as {
		SOMA_HUB_URL?: string;
		SOMA_HUB_TOKEN?: string;
		SOMA_ARCHIVE_PREFIX?: string;
		DB: D1Database;
	};
	if (!env.SOMA_HUB_URL && !env.SOMA_HUB_TOKEN && !env.SOMA_ARCHIVE_PREFIX) return null;
	if (!env.SOMA_HUB_URL || !env.SOMA_HUB_TOKEN || !env.SOMA_ARCHIVE_PREFIX)
		throw error(503, 'Archive configuration is incomplete.');
	return new ArchiveSource(
		archiveHeadStore(env.DB),
		new SomaArchive(env.SOMA_HUB_URL, env.SOMA_HUB_TOKEN, env.SOMA_ARCHIVE_PREFIX, fetchFn),
		env.SOMA_ARCHIVE_PREFIX
	);
}
const headers = { 'cache-control': 'private, no-store' };
export const GET: RequestHandler = async ({ platform, fetch, url }) => {
	const source = configured(platform, fetch);
	if (!source) {
		if (url.searchParams.has('file')) throw error(503, 'Archive is not configured.');
		return json({ enabled: false }, { headers });
	}
	try {
		const path = url.searchParams.get('file');
		if (path !== null)
			return new Response(await source.file(path), {
				headers: {
					...headers,
					'content-type': 'application/octet-stream',
					'content-disposition': 'attachment',
					'x-content-type-options': 'nosniff'
				}
			});
		const manifest = await source.manifest();
		// Upload devices use dashboard-relative paths, never service credentials or storage keys.
		return json(
			{
				enabled: true,
				version: 1,
				files: manifest.files.map((file) => ({ ...file, key: file.path }))
			},
			{ headers }
		);
	} catch (cause) {
		console.error(
			'Retained source read failed:',
			cause instanceof Error ? cause.message : 'unknown error'
		);
		throw error(502, 'Retained sources could not be read. Previous dashboard data is preserved.');
	}
};
export const POST: RequestHandler = async ({ platform, fetch, url, request }) => {
	const origin = request.headers.get('origin');
	if (origin && origin !== url.origin) throw error(403, 'Foreign-origin upload rejected.');
	const path = url.searchParams.get('file'),
		expected = request.headers.get('x-archive-expected');
	if (
		request.headers.get('content-type') !== 'application/octet-stream' ||
		!path ||
		!expected ||
		(expected !== 'new' && !/^[a-f0-9]{64}$/.test(expected))
	)
		throw error(400, 'A source path and expected version are required.');
	try {
		parseArchiveManifest({
			version: 1,
			files: [{ path, key: 'validation/file', sha256: '0'.repeat(64), bytes: 0 }]
		});
	} catch {
		throw error(400, 'Invalid source path.');
	}
	const source = configured(platform, fetch);
	if (!source) throw error(503, 'Archive is not configured.');
	try {
		const bytes = await boundedBytes(new Response(request.body));
		await source.put(path, bytes, expected === 'new' ? null : expected);
		return new Response(null, { status: 204, headers });
	} catch (cause) {
		if (cause instanceof Error && cause.message.includes('changed'))
			throw error(409, 'Archive changed. Reload source metadata before retrying.');
		throw error(502, 'Source retention was not confirmed. Previous dashboard data is preserved.');
	}
};
