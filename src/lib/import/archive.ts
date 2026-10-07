import type { DirLike, FileLike } from './importer';
import { isSnapshotDirName } from './paths';

export interface ArchiveFile {
	path: string;
	key: string;
	sha256: string;
	bytes: number;
}
export interface ArchiveManifest {
	version: 1;
	files: ArchiveFile[];
}
const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const safeKey = (value: unknown): value is string =>
	typeof value === 'string' &&
	value.length > 0 &&
	value.isWellFormed() &&
	!/[\\\u0000-\u001f\u007f?#%:]/.test(value) &&
	value.split('/').every((part) => !!part && part !== '.' && part !== '..');

/** Validate the complete manifest before exposing any file to the importer. */
export function parseArchiveManifest(value: unknown): ArchiveManifest {
	if (!object(value) || value.version !== 1 || !Array.isArray(value.files))
		throw new Error('Invalid archive manifest');
	const paths = new Set<string>();
	const files = value.files.map((row): ArchiveFile => {
		if (
			!object(row) ||
			!safeKey(row.path) ||
			!safeKey(row.key) ||
			row.path.split('/').length !== 2 ||
			!isSnapshotDirName(row.path.split('/')[0]) ||
			typeof row.sha256 !== 'string' ||
			!/^[a-f0-9]{64}$/.test(row.sha256) ||
			!Number.isSafeInteger(row.bytes) ||
			Number(row.bytes) < 0 ||
			paths.has(row.path)
		)
			throw new Error('Invalid or duplicate archive file');
		paths.add(row.path);
		return { path: row.path, key: row.key, sha256: row.sha256, bytes: Number(row.bytes) };
	});
	return { version: 1, files };
}

/** The caller owns authenticated transport; credentials never enter a manifest. */
export function archiveDirectory(
	manifest: ArchiveManifest,
	readFile: (key: string) => Promise<ArrayBuffer>
): DirLike {
	const validated = parseArchiveManifest(manifest);
	const snapshots = new Map<string, FileLike[]>();
	for (const file of validated.files) {
		const [snapshot, name] = file.path.split('/');
		const entry: FileLike = {
			kind: 'file',
			name,
			getCachedHash: async () => file.sha256,
			async getFile() {
				const bytes = await readFile(file.key);
				if (bytes.byteLength !== file.bytes) throw new Error('Archive file size mismatch');
				const actual = Array.from(
					new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
					(b) => b.toString(16).padStart(2, '0')
				).join('');
				if (actual !== file.sha256) throw new Error('Archive file checksum mismatch');
				return { arrayBuffer: async () => bytes };
			}
		};
		snapshots.set(snapshot, [...(snapshots.get(snapshot) ?? []), entry]);
	}
	return {
		async *values() {
			for (const [name, files] of [...snapshots].sort(([a], [b]) => a.localeCompare(b)))
				yield {
					kind: 'directory' as const,
					name,
					async *values() {
						yield* files;
					}
				};
		}
	};
}
