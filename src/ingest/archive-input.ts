import type { DirLike, FileLike } from '../lib/import/importer';
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
			const newest = snapshots.at(-1)?.name?.slice(0, 10);
			for (const snapshot of snapshots)
				if (snapshot.name!.slice(0, 10) === newest || !archived.has(snapshot.name!)) {
					const prior = archived.get(snapshot.name!);
					archived.set(
						snapshot.name!,
						prior
							? {
									kind: 'directory',
									name: snapshot.name,
									async *values() {
										const files = new Map<string, FileLike>();
										for await (const file of prior.values())
											if (file.kind === 'file') files.set(file.name, file);
										for await (const file of snapshot.values())
											if (file.kind === 'file') files.set(file.name, file);
										yield* files.values();
									}
								}
							: snapshot
					);
				}
			for (const [, entry] of [...archived].sort(([a], [b]) => a.localeCompare(b))) yield entry;
		}
	};
}
