// DirLike over a real directory (node:fs), for the ingest CLI. Files are read
// lazily so a snapshot's 10MB tarballs only load when the walker asks.
//
// Reads are bounded by a timeout: the backups folder is iCloud-synced, and a
// file that is evicted but not (yet) downloadable blocks read() indefinitely.
// A timed-out read throws, which the walker records as that file's error and
// moves on - one stuck snapshot must not wedge the whole sync.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DirLike, FileLike } from '../lib/import/importer';

export const DEFAULT_READ_TIMEOUT_MS = 2 * 60_000;

export function readWithTimeout(path: string, timeoutMs: number): Promise<Buffer> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(new Error(`read timed out after ${timeoutMs}ms (iCloud not delivering the file?)`)),
			timeoutMs
		);
	});
	return Promise.race([readFile(path), timeout]).finally(() => clearTimeout(timer));
}

export function fsDir(
	path: string,
	name?: string,
	readTimeoutMs = DEFAULT_READ_TIMEOUT_MS
): DirLike {
	return {
		kind: 'directory',
		name,
		async *values(): AsyncIterable<FileLike | DirLike> {
			for (const entry of await readdir(path, { withFileTypes: true })) {
				const full = join(path, entry.name);
				if (entry.isDirectory()) yield fsDir(full, entry.name, readTimeoutMs);
				else if (entry.isFile()) {
					yield {
						kind: 'file',
						name: entry.name,
						getFile: async () => {
							const bytes = await readWithTimeout(full, readTimeoutMs);
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
