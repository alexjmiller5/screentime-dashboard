// Pure classification helpers for the import walker.

/** Snapshot dirs are date-named: 2026-08-23, 2026-07-05-0008, *-macbook-seed… */
export function isSnapshotDirName(name: string): boolean {
	return /^\d{4}-\d{2}-\d{2}(-.+)?$/.test(name);
}

export type StreamFileKind = { kind: 'infocus-remote'; device: string };

/**
 * Classify a path inside biome-streams.tar.gz. Only remote App.InFocus
 * segments carry cross-device usage events; tombstone/ files are deletion
 * bookkeeping, local/ is the writing machine's own (empty on the mini).
 */
export function classifyStreamFile(path: string): StreamFileKind | null {
	const match = /^App\.InFocus\/remote\/([0-9A-Fa-f-]{36})\/[^/]+$/.exec(path);
	return match ? { kind: 'infocus-remote', device: match[1] } : null;
}
