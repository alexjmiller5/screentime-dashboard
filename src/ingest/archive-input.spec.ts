import { expect, it, vi } from 'vitest';
import type { DirLike } from '../lib/import/importer';
import { refreshDirectory } from './archive-input';
const snapshot = (name: string): DirLike => ({
	kind: 'directory',
	name,
	values: vi.fn(async function* () {})
});
const directory = (entries: DirLike[]): DirLike => ({
	async *values() {
		yield* entries;
	}
});
it('does not enumerate archived old local snapshots, but checks the newest and unseen dates', async () => {
	const old = snapshot('2030-01-01'),
		fresh = snapshot('2030-01-03'),
		unseen = snapshot('2030-01-02');
	const retained = snapshot(old.name!),
		latest = snapshot(fresh.name!);
	const output = refreshDirectory(directory([old, fresh, unseen]), directory([retained, latest]));
	const selected = [];
	for await (const entry of output.values()) {
		selected.push(entry);
		if (entry.kind === 'directory') for await (const ignored of entry.values()) void ignored;
	}
	expect(selected.map((entry) => entry.name)).toEqual([retained.name, unseen.name, fresh.name]);
	expect(selected[0]).toBe(retained);
	expect(old.values).not.toHaveBeenCalled();
	expect(retained.values).toHaveBeenCalled();
	expect(fresh.values).toHaveBeenCalled();
	expect(unseen.values).toHaveBeenCalled();
});
it('keeps retained history when local backups have been removed and ignores unrelated folders', async () => {
	const retained = snapshot('2030-01-01'),
		unrelated = snapshot('unrelated');
	const selected = [];
	for await (const entry of refreshDirectory(
		directory([unrelated]),
		directory([retained])
	).values())
		selected.push(entry);
	expect(selected).toEqual([retained]);
	expect(unrelated.values).not.toHaveBeenCalled();
});
it('checks every device snapshot on the latest day and retains missing local files', async () => {
	const file = (name: string) => ({
		kind: 'file' as const,
		name,
		getFile: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })
	});
	const localFile = file('biome-streams.tar.gz'),
		retainedFile = file('knowledgeC.db.gz');
	const local = snapshot('2030-01-03'),
		peer = snapshot('2030-01-03-device');
	local.values = vi.fn(async function* () {
		yield localFile;
	});
	const saved = snapshot(local.name!);
	saved.values = vi.fn(async function* () {
		yield retainedFile;
	});
	const selected = [];
	for await (const entry of refreshDirectory(
		directory([local, peer]),
		directory([saved, snapshot(peer.name!)])
	).values()) {
		if (entry.kind === 'directory')
			for await (const file of entry.values()) selected.push(file.name);
	}
	expect(local.values).toHaveBeenCalled();
	expect(peer.values).toHaveBeenCalled();
	expect(selected.sort()).toEqual(['biome-streams.tar.gz', 'knowledgeC.db.gz']);
});
