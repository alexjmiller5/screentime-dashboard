// DirLike over a real directory (node:fs), for the ingest CLI. Files are read
// lazily so a snapshot's 10MB tarballs only load when the walker asks.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DirLike, FileLike } from '../lib/import/importer';

export function fsDir(path: string, name?: string): DirLike {
	return {
		kind: 'directory',
		name,
		async *values(): AsyncIterable<FileLike | DirLike> {
			for (const entry of await readdir(path, { withFileTypes: true })) {
				const full = join(path, entry.name);
				if (entry.isDirectory()) yield fsDir(full, entry.name);
				else if (entry.isFile()) {
					yield {
						kind: 'file',
						name: entry.name,
						getFile: async () => {
							const bytes = await readFile(full);
							return {
								arrayBuffer: async () =>
									bytes.buffer.slice(
										bytes.byteOffset,
										bytes.byteOffset + bytes.byteLength
									) as ArrayBuffer
							};
						}
					};
				}
			}
		}
	};
}
