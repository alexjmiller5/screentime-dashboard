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
	expect(selected).toEqual([retained, unseen, fresh]);
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
