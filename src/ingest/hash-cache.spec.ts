import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fsDir } from './fsdir';
import { loadHashCache, saveHashCache, fileFingerprint } from './hash-cache';
import { syncBackups, PARSER_VERSION, type FetchFn } from '../lib/import/incremental';

vi.mock('node:fs/promises', { spy: true });

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.resetAllMocks();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await fs.mkdtemp(join(tmpdir(), 'screentime-hash-test-'));
	roots.push(root);
	const snapshot = join(root, '2026-01-05');
	await fs.mkdir(snapshot);
	const archive = join(snapshot, 'knowledgeC.db.gz');
	await fs.writeFile(archive, gzipSync('first'));
	const cachePath = join(root, 'state', 'file-hashes.json');
	let ledger: Record<string, unknown>[] = [];
	const uploads: Record<string, unknown>[] = [];
	const fetchFn: FetchFn = async (_url, init) => {
		if (!init?.body) return Response.json({ files: ledger, timeZone: 'UTC' });
		const body = JSON.parse(String(init.body));
		if (body.action === 'begin') {
			uploads.push(body);
			return Response.json({ uploadId: 'upload' });
		}
		if (body.action === 'complete') ledger = [uploads.at(-1)!];
		return new Response(null, { status: 204 });
	};
	const querySqlite = vi.fn(async () => []);
	const run = async (force = false) => {
		const cache = await loadHashCache(cachePath);
		const result = await syncBackups(fsDir(root, undefined, 1000, cache), {
			timeZone: 'UTC',
			fetchFn,
			querySqlite,
			force
		});
		await saveHashCache(cachePath, cache);
		return result;
	};
	return {
		root,
		archive,
		cachePath,
		uploads,
		run,
		querySqlite,
		changeLedger: (value: Record<string, unknown>[]) => {
			ledger = value;
		}
	};
}
it('a warm native refresh skips reading and hashing committed unchanged archives across runs', async () => {
	const f = await fixture();
	expect(await f.run()).toMatchObject({ imported: 1, skipped: 0, failed: 0 });
	const read = vi.spyOn(fs, 'readFile').mockClear();
	const hash = vi.spyOn(crypto.subtle, 'digest');
	expect(await f.run()).toMatchObject({ imported: 0, skipped: 1, failed: 0 });
	expect(read.mock.calls.filter(([path]) => path === f.archive)).toHaveLength(0);
	expect(hash).not.toHaveBeenCalled();
	expect(f.querySqlite).toHaveBeenCalledTimes(1);
});
it('same-size corrected bytes with restored mtime invalidate the cached identity', async () => {
	const f = await fixture();
	const fixedTime = new Date('2026-01-01T00:00:00.000Z');
	await fs.utimes(f.archive, fixedTime, fixedTime);
	await f.run();
	const before = await fs.stat(f.archive, { bigint: true });
	await fs.writeFile(f.archive, gzipSync('other'));
	await fs.utimes(f.archive, fixedTime, fixedTime);
	const after = await fs.stat(f.archive, { bigint: true });
	expect(after.size).toBe(before.size);
	expect(after.mtimeNs).toBe(before.mtimeNs);
	expect(await f.run()).toMatchObject({ imported: 1, skipped: 0, failed: 0 });
	expect(f.uploads[0].hash).not.toBe(f.uploads[1].hash);
});
it('replacement files at the same path are rechecked', async () => {
	const f = await fixture();
	await f.run();
	const replacement = join(f.root, 'replacement');
	await fs.writeFile(replacement, gzipSync('other'));
	await fs.rename(replacement, f.archive);
	expect(await f.run()).toMatchObject({ imported: 1, failed: 0 });
	expect(f.uploads[0].hash).not.toBe(f.uploads[1].hash);
});
it.each(['force', 'parser', 'ledger'])(
	'%s reprocesses files despite a matching local memo',
	async (reason) => {
		const f = await fixture();
		await f.run();
		if (reason === 'parser')
			f.changeLedger([{ ...f.uploads[0], parserVersion: PARSER_VERSION - 1 }]);
		if (reason === 'ledger') f.changeLedger([]);
		const reads = vi.spyOn(fs, 'readFile').mockClear();
		expect(await f.run(reason === 'force')).toMatchObject({ imported: 1, skipped: 0, failed: 0 });
		expect(reads.mock.calls.filter(([path]) => path === f.archive)).toHaveLength(1);
		expect(f.querySqlite).toHaveBeenCalledTimes(2);
	}
);
it('metadata changes without content changes refresh the memo but do not reimport', async () => {
	const f = await fixture();
	await f.run();
	await fs.utimes(f.archive, new Date(), new Date(0));
	const reads = vi.spyOn(fs, 'readFile').mockClear();
	expect(await f.run()).toMatchObject({ imported: 0, skipped: 1, failed: 0 });
	expect(reads.mock.calls.filter(([path]) => path === f.archive)).toHaveLength(1);
	reads.mockClear();
	expect(await f.run()).toMatchObject({ imported: 0, skipped: 1, failed: 0 });
	expect(reads.mock.calls.filter(([path]) => path === f.archive)).toHaveLength(0);
});
it('corrupt local cache falls back to reading the archive', async () => {
	const f = await fixture();
	await f.run();
	await fs.writeFile(f.cachePath, 'not JSON');
	const reads = vi.spyOn(fs, 'readFile').mockClear();
	expect(await f.run()).toMatchObject({ imported: 0, skipped: 1, failed: 0 });
	expect(reads.mock.calls.filter(([path]) => path === f.archive)).toHaveLength(1);
});
it('insufficient or coarse metadata never authorizes a cached hash', () => {
	const metadata = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 1_500_000_001n, ctimeNs: 1_600_000_001n };
	expect(fileFingerprint(metadata)).toBe('1:2:3:1500000001:1600000001');
	expect(fileFingerprint({ ...metadata, ctimeNs: 1_600_000_000n })).toBeUndefined();
	expect(fileFingerprint({ ...metadata, ino: 0n })).toBeUndefined();
	expect(fileFingerprint({ ...metadata, ctimeNs: undefined })).toBeUndefined();
});
it('a file modified during a read is neither memoized nor uploaded', async () => {
	const f = await fixture();
	const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
	let changed = false;
	vi.mocked(fs.readFile).mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
		const bytes = await actual.readFile(...args);
		if (args[0] === f.archive && !changed) {
			changed = true;
			await fs.writeFile(f.archive, gzipSync('other'));
		}
		return bytes;
	}) as typeof fs.readFile);
	expect(await f.run()).toMatchObject({
		imported: 0,
		skipped: 0,
		failed: 1,
		errors: [expect.stringContaining('changed while being read')]
	});
	expect(f.uploads).toEqual([]);
	expect((await loadHashCache(f.cachePath)).size).toBe(0);
});
it('a malformed memo entry cannot skip a read even with a valid cache envelope', async () => {
	const f = await fixture();
	await f.run();
	await fs.writeFile(
		f.cachePath,
		JSON.stringify({
			version: 1,
			files: [[f.archive, { fingerprint: 123, hash: f.uploads[0].hash }]]
		})
	);
	const reads = vi.spyOn(fs, 'readFile').mockClear();
	expect(await f.run()).toMatchObject({ imported: 0, skipped: 1, failed: 0 });
	expect(reads.mock.calls.filter(([path]) => path === f.archive)).toHaveLength(1);
});
it('failed uploads cannot become skips through the local memo', async () => {
	const f = await fixture();
	await f.run();
	f.changeLedger([]);
	const cache = await loadHashCache(f.cachePath);
	const failed = await syncBackups(fsDir(f.root, undefined, 1000, cache), {
		querySqlite: async () => [],
		timeZone: 'UTC',
		fetchFn: async (_url, init) =>
			init?.body ? new Response('offline', { status: 503 }) : Response.json({ files: [] })
	});
	expect(failed).toMatchObject({ imported: 0, failed: 1 });
	await saveHashCache(f.cachePath, cache);
	expect(await f.run()).toMatchObject({ imported: 1, skipped: 0, failed: 0 });
});
