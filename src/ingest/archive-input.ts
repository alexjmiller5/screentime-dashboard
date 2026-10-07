import type { DirLike } from '../lib/import/importer';
import { isSnapshotDirName } from '../lib/import/paths';

/** Retained history avoids opening old local directories during ordinary refresh. */
export function refreshDirectory(local: DirLike, retained: DirLike): DirLike {
	return {
		async *values() {
			const archived = new Map<string, DirLike>();
			for await (const entry of retained.values())
				if (entry.kind === 'directory' && entry.name) archived.set(entry.name, entry);
			const snapshots: DirLike[] = [];
			for await (const entry of local.values())
				if (entry.kind === 'directory' && entry.name && isSnapshotDirName(entry.name))
					snapshots.push(entry);
			snapshots.sort((a, b) => a.name!.localeCompare(b.name!));
			const newest = snapshots.at(-1)?.name;
			for (const snapshot of snapshots)
				if (snapshot.name === newest || !archived.has(snapshot.name!))
					archived.set(snapshot.name!, snapshot);
			for (const [, entry] of [...archived].sort(([a], [b]) => a.localeCompare(b))) yield entry;
		}
	};
}
