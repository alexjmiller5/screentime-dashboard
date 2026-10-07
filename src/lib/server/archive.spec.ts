import { expect, it, vi } from 'vitest';
import { LifeArchive } from './archive';
const bytes = new TextEncoder().encode('original');
const digest = async (b: Uint8Array<ArrayBuffer>) =>
	Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (x) =>
		x.toString(16).padStart(2, '0')
	).join('');
it('keeps requests on the configured service and prefix, without forwarding redirects', async () => {
	const fetch = vi.fn().mockResolvedValue(new Response(bytes));
	const archive = new LifeArchive('https://hub.example', 'secret', 'raw/example/', fetch);
	await expect(archive.read('raw/other/private')).rejects.toThrow();
	await expect(archive.read('raw/example/../private')).rejects.toThrow();
	expect(fetch).not.toHaveBeenCalled();
	await archive.read('raw/example/file');
	expect(fetch.mock.calls[0][0]).toBe('https://hub.example/v1/files/raw/example/file');
	expect(fetch.mock.calls[0][1]).toMatchObject({
		redirect: 'error',
		headers: { Authorization: 'Bearer secret', 'User-Agent': 'screentime-dashboard/1.0' }
	});
});
it('publishes originals only with conditional creation and server-verified checksum, resolving replay by readback', async () => {
	const sha = await digest(bytes);
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ sha256: sha, bytes: bytes.length }), { status: 201 })
		)
		.mockResolvedValueOnce(new Response(null, { status: 412 }))
		.mockResolvedValueOnce(new Response(bytes));
	const archive = new LifeArchive('https://hub.example', 'secret', 'raw/example/', fetch);
	await archive.create('raw/example/file', bytes.buffer);
	await archive.create('raw/example/file', bytes.buffer);
	expect(fetch.mock.calls[0][1]).toMatchObject({
		method: 'PUT',
		headers: { 'If-None-Match': '*', 'X-Content-SHA256': sha }
	});
});
it('rejects corrupt or ambiguous retained content instead of accepting a success status alone', async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(new Response('{}', { status: 201 }))
		.mockResolvedValueOnce(new Response(null, { status: 412 }))
		.mockResolvedValueOnce(new Response('changed'));
	const archive = new LifeArchive('https://hub.example', 'secret', 'raw/example/', fetch);
	await expect(archive.create('raw/example/file', bytes.buffer)).rejects.toThrow();
	await expect(archive.create('raw/example/file', bytes.buffer)).rejects.toThrow();
});
it('forbids credentials and non-origin paths in service URLs', () => {
	for (const url of [
		'http://foreign.example',
		'https://user:pass@hub.example',
		'https://hub.example/path',
		'https://hub.example/?x=1'
	])
		expect(() => new LifeArchive(url, 'secret', 'raw/example/', vi.fn())).toThrow();
});
