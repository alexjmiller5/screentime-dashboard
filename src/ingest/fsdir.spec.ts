import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsDir, readWithTimeout } from './fsdir';
import type { DirLike, FileLike } from '../lib/import/importer';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('fsDir', () => {
	it('yields subdirectories and files with lazily-read bytes', async () => {
		const root = await mkdtemp(join(tmpdir(), 'fsdir-'));
		roots.push(root);
		await mkdir(join(root, '2026-01-05'));
		await writeFile(join(root, '2026-01-05', 'a.bin'), Buffer.from([1, 2, 3]));
		await writeFile(join(root, 'loose.txt'), 'x');

		const seen: Record<string, string[]> = {};
		for await (const entry of fsDir(root).values()) {
			if (entry.kind === 'directory') {
				const dir = entry.name ?? '?';
				seen[dir] = [];
				for await (const f of (entry as DirLike).values()) {
					const bytes = new Uint8Array(await (await (f as FileLike).getFile()).arrayBuffer());
					seen[dir].push(`${f.name}:${[...bytes].join(',')}`);
				}
			} else if (entry.kind === 'file') seen[entry.name] = [];
		}
		expect(seen).toEqual({ '2026-01-05': ['a.bin:1,2,3'], 'loose.txt': [] });
	});
});

describe('readWithTimeout', () => {
	it('gives up on a read that never completes', async () => {
		const root = await mkdtemp(join(tmpdir(), 'fsdir-fifo-'));
		roots.push(root);
		const fifo = join(root, 'stuck');
		execFileSync('mkfifo', [fifo]); // a FIFO with no writer blocks open/read forever
		try {
			await expect(readWithTimeout(fifo, 200)).rejects.toThrow('read timed out');
		} finally {
			await writeFile(fifo, ''); // Release the pending read before removing its fixture.
		}
	});
});
