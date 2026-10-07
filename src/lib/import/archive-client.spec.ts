import { expect, it, vi } from 'vitest';
import { ArchiveClient } from './archive-client';
const file = {
	path: '2030-01-01/biome-streams.tar.gz',
	key: '2030-01-01/biome-streams.tar.gz',
	sha256: '1'.repeat(64),
	bytes: 3
};
it('only treats an explicit disabled archive as local-only', async () => {
	expect(
		await ArchiveClient.open(
			'https://site.example',
			vi.fn().mockResolvedValue(Response.json({ enabled: false }))
		)
	).toBeNull();
	await expect(
		ArchiveClient.open(
			'https://site.example',
			vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
		)
	).rejects.toThrow();
	await expect(
		ArchiveClient.open('https://site.example', vi.fn().mockResolvedValue(Response.json({})))
	).rejects.toThrow();
});
it('retains missing originals with the captured prior hash and memoizes only confirmed writes', async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json({ enabled: true, version: 1, files: [file] }))
		.mockResolvedValueOnce(new Response(null, { status: 204 }));
	const client = (await ArchiveClient.open('https://site.example', fetch))!;
	expect(client.has(file.path, file.sha256)).toBe(true);
	await client.retain(file.path, new Uint8Array([1, 2, 3]).buffer, '2'.repeat(64));
	expect(fetch.mock.calls[1][1]).toMatchObject({ headers: { 'x-archive-expected': file.sha256 } });
	expect(client.has(file.path, '2'.repeat(64))).toBe(true);
});
it('a rejected archival write cannot mark a local file retained', async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json({ enabled: true, version: 1, files: [] }))
		.mockResolvedValueOnce(new Response(null, { status: 409 }));
	const client = (await ArchiveClient.open('https://site.example', fetch))!;
	await expect(
		client.retain(file.path, new Uint8Array([1, 2, 3]).buffer, file.sha256)
	).rejects.toThrow();
	expect(client.has(file.path, file.sha256)).toBe(false);
});
