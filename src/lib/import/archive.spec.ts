import type { DirLike } from './importer';
import { describe, expect, it, vi } from 'vitest';
import { archiveDirectory, parseArchiveManifest } from './archive';
const bytes = new TextEncoder().encode('source bytes').buffer;
const hash = '9ed02ed62ff4b7669f8b3baaf2f2c5a6c8ffcd784297d716743e960b4cd093c4';
const digest = async () =>
	Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
		b.toString(16).padStart(2, '0')
	).join('');
const file = {
	path: '2030-01-01/knowledgeC.db.gz',
	key: 'raw/sources/one',
	sha256: hash,
	bytes: 12
};
const manifest = (files: unknown[] = [file]) => ({ version: 1, files });
describe('retained archive import', () => {
	it('rejects ambiguous paths, duplicate entries and malformed checksums before any read', () => {
		for (const patch of [
			{ path: '../knowledgeC.db.gz' },
			{ path: '2030-01-01/../knowledgeC.db.gz' },
			{ path: '2030-01-01//knowledgeC.db.gz' },
			{ path: '2030-01-01\\knowledgeC.db.gz' },
			{ key: 'https://foreign.test/file' },
			{ key: 'raw/../secret' },
			{ sha256: 'A'.repeat(64) },
			{ bytes: -1 },
			{ bytes: 1.5 }
		])
			expect(() => parseArchiveManifest(manifest([{ ...file, ...patch }]))).toThrow();
		expect(() => parseArchiveManifest(manifest([file, file]))).toThrow();
		expect(() => parseArchiveManifest({ version: 2, files: [] })).toThrow();
	});
	it('does not fetch source bytes for an unchanged manifest hash', async () => {
		const read = vi.fn();
		const dir = archiveDirectory(parseArchiveManifest(manifest()), read);
		const [snapshot] = await Array.fromAsync(dir.values());
		const [entry] = await Array.fromAsync((snapshot as DirLike).values());
		if (entry.kind !== 'file') throw new Error('Expected file');
		expect(await entry.getCachedHash!()).toBe(hash);
		expect(read).not.toHaveBeenCalled();
	});
	it('checks both byte count and SHA before exposing bytes to a parser', async () => {
		const sha256 = await digest();
		const read = vi.fn().mockResolvedValue(bytes);
		const dir = archiveDirectory(parseArchiveManifest(manifest([{ ...file, sha256 }])), read);
		const [snapshot] = await Array.fromAsync(dir.values());
		const [entry] = await Array.fromAsync((snapshot as DirLike).values());
		if (entry.kind !== 'file') throw new Error('Expected file');
		expect(await (await entry.getFile()).arrayBuffer()).toEqual(bytes);
		expect(read).toHaveBeenCalledWith('raw/sources/one');
		read.mockResolvedValue(new TextEncoder().encode('changed byte').buffer);
		await expect(entry.getFile()).rejects.toThrow('checksum');
		read.mockResolvedValue(new ArrayBuffer(4));
		await expect(entry.getFile()).rejects.toThrow('size');
	});
	it('preserves all archived file names while the existing parser selects supported formats', async () => {
		const dir = archiveDirectory(
			parseArchiveManifest(manifest([{ ...file, path: '2030-01-02/extra.json' }, file])),
			vi.fn()
		);
		const folders = await Array.fromAsync(dir.values());
		expect(folders.map((f) => f.name)).toEqual(['2030-01-01', '2030-01-02']);
	});
});
