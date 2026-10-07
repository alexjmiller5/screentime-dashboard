import { expect, it, vi } from 'vitest';
import { ArchiveSource } from './archive-source';
import { sha256 } from './archive';
function fixture() {
	let head: string | null = null;
	const blobs = new Map<string, ArrayBuffer>();
	const state = {
		get: async () => head,
		swap: async (expected: string | null, next: string) => {
			if (head !== expected) return false;
			head = next;
			return true;
		}
	};
	const archive = {
		read: vi.fn(async (key: string) => {
			const b = blobs.get(key);
			if (!b) throw Error('missing');
			return b;
		}),
		create: vi.fn(async (key: string, b: ArrayBuffer) => {
			const prior = blobs.get(key);
			if (prior && (await sha256(prior)) !== (await sha256(b))) throw Error('conflict');
			blobs.set(key, b);
		})
	};
	return { state, archive, source: new ArchiveSource(state, archive, 'raw/example/') };
}
const bytes = new TextEncoder().encode('source').buffer;
it('retains bytes and an immutable manifest before advancing the current reference', async () => {
	const f = fixture();
	await f.source.put('2030-01-01/biome-streams.tar.gz', bytes, null);
	const m = await f.source.manifest();
	expect(m.files).toHaveLength(1);
	expect(await f.source.file(m.files[0].path)).toEqual(bytes);
	expect(f.archive.create).toHaveBeenCalledTimes(2);
	await f.source.put(m.files[0].path, bytes, null);
	expect((await f.source.manifest()).files).toHaveLength(1);
});
it('rejects stale source replacement and preserves prior bytes', async () => {
	const f = fixture();
	const path = '2030-01-01/biome-streams.tar.gz';
	await f.source.put(path, bytes, null);
	await expect(f.source.put(path, new Uint8Array([1]).buffer, null)).rejects.toThrow('changed');
	expect(await f.source.file(path)).toEqual(bytes);
	await f.source.put(path, new Uint8Array([1]).buffer, await sha256(bytes));
	expect(await f.source.file(path)).toEqual(new Uint8Array([1]).buffer);
});
it('failed retention never advances the manifest', async () => {
	const f = fixture();
	f.archive.create.mockRejectedValueOnce(Error('offline'));
	await expect(f.source.put('2030-01-01/knowledgeC.db.gz', bytes, null)).rejects.toThrow();
	expect(await f.state.get()).toBeNull();
});
it('does not silently drop concurrent additions when publishing a manifest', async () => {
	const f = fixture();
	const real = f.state.swap;
	let conflict = true;
	f.state.swap = async (expected, next) => {
		if (conflict) {
			conflict = false;
			await f.source.put('2030-01-02/knowledgeC.db.gz', bytes, null);
			return false;
		}
		return real(expected, next);
	};
	await f.source.put('2030-01-01/knowledgeC.db.gz', bytes, null);
	expect((await f.source.manifest()).files.map((f) => f.path)).toEqual([
		'2030-01-01/knowledgeC.db.gz',
		'2030-01-02/knowledgeC.db.gz'
	]);
});
it('checks manifest and original checksums on read and rejects unknown paths', async () => {
	const f = fixture();
	await f.source.put('2030-01-01/knowledgeC.db.gz', bytes, null);
	await expect(f.source.file('2030-01-02/knowledgeC.db.gz')).rejects.toThrow('not archived');
	f.archive.read.mockResolvedValueOnce(new TextEncoder().encode('{}').buffer);
	await expect(f.source.manifest()).rejects.toThrow('checksum');
});

it('rejects corruption of original bytes even if their length still matches', async () => {
	const f = fixture();
	const path = '2030-01-01/knowledgeC.db.gz';
	await f.source.put(path, bytes, null);
	const original = f.archive.read.getMockImplementation()!;
	f.archive.read.mockImplementation(async (key) =>
		key.includes('/originals/') ? new TextEncoder().encode('broken').buffer : original(key)
	);
	await expect(f.source.file(path)).rejects.toThrow('checksum');
});
