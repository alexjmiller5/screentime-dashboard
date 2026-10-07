// DirLike over a real directory (node:fs), for the ingest CLI. Files are read
// lazily so a snapshot's 10MB tarballs only load when the walker asks.
//
// Reads are bounded by a timeout: the backups folder is iCloud-synced, and a
// file that is evicted but not (yet) downloadable blocks read() indefinitely.
// A timed-out read throws, which the walker records as that file's error and
// moves on - one stuck snapshot must not wedge the whole sync.

import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DirLike, FileLike } from '../lib/import/importer';
import { fileFingerprint, type HashCache } from './hash-cache';

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
	readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
	hashCache?: HashCache
): DirLike {
	return {
		kind: 'directory',
		name,
		async *values(): AsyncIterable<FileLike | DirLike> {
			for (const entry of await readdir(path, { withFileTypes: true })) {
				const full = resolve(path, entry.name);
				if (entry.isDirectory()) yield fsDir(full, entry.name, readTimeoutMs, hashCache);
				else if (entry.isFile()) {
					let readFingerprint: string | undefined;
					yield {
						kind: 'file',
						name: entry.name,
						getCachedHash: async () => {
							const cached = hashCache?.get(full);
							if (!cached) return;
							const fingerprint = fileFingerprint(await stat(full, { bigint: true }));
							if (fingerprint && cached.fingerprint === fingerprint) return cached.hash;
						},
						rememberHash: (hash) => {
							if (readFingerprint) hashCache?.set(full, { fingerprint: readFingerprint, hash });
						},
						getFile: async () => {
							readFingerprint = undefined;
							const before = hashCache
								? fileFingerprint(await stat(full, { bigint: true }))
								: undefined;
							const bytes = await readWithTimeout(full, readTimeoutMs);
							if (before) {
								const after = fileFingerprint(await stat(full, { bigint: true }));
								if (before !== after)
									throw new Error('Backup file changed while being read; retry refresh');
								readFingerprint = after;
							}
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
