import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { syncBackups, PARSER_VERSION, chunkImportResult, type FetchFn } from './incremental';
import { filesToDir } from './browser';
import { importBackups, type DirLike, type ImportResult } from './importer';

const streams = new Uint8Array(
	readFileSync(new URL('../data/fixtures/streams.tar.gz', import.meta.url))
);
const activity = new Uint8Array(
	readFileSync(new URL('../data/fixtures/device-activity.tar.gz', import.meta.url))
);
function dir(snapshots: Record<string, Record<string, Uint8Array>>): DirLike {
	return {
		async *values() {
			for (const [name, files] of Object.entries(snapshots))
				yield {
					kind: 'directory' as const,
					name,
					async *values() {
						for (const [name, bytes] of Object.entries(files))
							yield {
								kind: 'file' as const,
								name,
								getFile: async () => ({
									arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer
								})
							};
					}
				};
		}
	};
}
function server(files: { path: string; hash: string; parserVersion: number }[] = []) {
	const posts: Record<string, any>[] = [];
	const fetchFn = vi.fn<FetchFn>(async (_url, init) => {
		if (!init?.body) return Response.json({ files, timeZone: 'UTC' });
		const body = JSON.parse(String(init.body));
		posts.push(body);
		return body.action === 'begin'
			? Response.json({ uploadId: 'upload-1' })
			: new Response(null, { status: 204 });
	});
	return { posts, fetchFn };
}
const querySqlite = async () => [];

describe('syncBackups', () => {
	it.each(['ledger request', 'invalid ledger', 'root enumeration', 'no supported files'])(
		'counts a fatal %s error as one failure',
		async (scenario) => {
			const api = server();
			const input: DirLike =
				scenario === 'root enumeration'
					? {
							async *values() {
								throw new Error('Root folder unavailable');
							}
						}
					: dir({ '2026-01-05': { 'unsupported.gz': streams } });
			const fetchFn: FetchFn =
				scenario === 'ledger request'
					? async () => new Response('Ledger unavailable', { status: 503 })
					: scenario === 'invalid ledger'
						? async () => Response.json({})
						: api.fetchFn;
			const result = await syncBackups(input, { querySqlite, fetchFn, timeZone: 'UTC' });
			expect(result).toMatchObject({ imported: 0, skipped: 0, failed: 1 });
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]).toMatch(
				/Ledger unavailable|Invalid import ledger|Root folder unavailable|No supported backup files/
			);
			expect(api.posts).toEqual([]);
		}
	);

	it('imports all dated directories and all three supported files, then skips matching ledger entries', async () => {
		const input = dir({
			'2026-01-12-macbook': { 'biome-streams.tar.gz': streams },
			'not-a-date': { 'biome-streams.tar.gz': streams },
			'2026-01-05': {
				'biome-streams.tar.gz': streams,
				'device-activity.tar.gz': activity,
				'knowledgeC.db.gz': new Uint8Array(gzipSync('db')),
				'ignored.gz': streams
			}
		});
		const api = server();
		expect(
			await syncBackups(input, { querySqlite, fetchFn: api.fetchFn, timeZone: 'UTC' })
		).toEqual({ imported: 4, skipped: 0, failed: 0, errors: [] });
		const begins = api.posts.filter((p) => p.action === 'begin');
		expect(begins.map((p) => p.path)).toEqual([
			'2026-01-05/biome-streams.tar.gz',
			'2026-01-05/device-activity.tar.gz',
			'2026-01-05/knowledgeC.db.gz',
			'2026-01-12-macbook/biome-streams.tar.gz'
		]);
		expect(
			begins.every((p) => /^[a-f0-9]{64}$/.test(p.hash) && p.parserVersion === PARSER_VERSION)
		).toBe(true);
		const skipped = server(begins as any);
		expect(
			await syncBackups(input, { querySqlite, fetchFn: skipped.fetchFn, timeZone: 'UTC' })
		).toEqual({ imported: 0, skipped: 4, failed: 0, errors: [] });
		expect(skipped.posts).toEqual([]);
		const force = server(begins as any);
		expect(
			(
				await syncBackups(input, {
					querySqlite,
					fetchFn: force.fetchFn,
					timeZone: 'UTC',
					force: true
				})
			).imported
		).toBe(4);
		const changed = server(
			begins.map((p, i) => ({
				...p,
				...(i === 0 ? { hash: 'old' } : i === 1 ? { parserVersion: 0 } : {})
			})) as any
		);
		expect(
			(await syncBackups(input, { querySqlite, fetchFn: changed.fetchFn, timeZone: 'UTC' }))
				.imported
		).toBe(2);
	});
	it('never begins or commits a failed parse and keeps importing good files', async () => {
		const api = server();
		const result = await syncBackups(
			dir({
				'2026-01-05': {
					'biome-streams.tar.gz': new Uint8Array([1, 2, 3]),
					'device-activity.tar.gz': activity
				}
			}),
			{ querySqlite, fetchFn: api.fetchFn, timeZone: 'UTC' }
		);
		expect(result).toMatchObject({ imported: 1, skipped: 0, failed: 1 });
		expect(result.errors[0]).toMatch(/2026-01-05\/biome-streams.tar.gz: .+/);
		expect(api.posts.filter((p) => p.action === 'begin').map((p) => p.path)).toEqual([
			'2026-01-05/device-activity.tar.gz'
		]);
		expect(api.posts.filter((p) => p.action === 'complete')).toHaveLength(1);
	});
	it('discards partial events when a later archive member fails parsing', async () => {
		const valid = new Uint8Array(
			readFileSync(new URL('../data/fixtures/infocus.segb', import.meta.url))
		);
		const members = [valid, new Uint8Array([1, 2, 3])].map((data, index) => {
			const bytes = new Uint8Array(512 + Math.ceil(data.length / 512) * 512);
			const encode = new TextEncoder();
			bytes.set(encode.encode(`App.InFocus/remote/AAAAAAAA-1111-2222-3333-444444444444/${index}`));
			bytes.set(encode.encode(data.length.toString(8).padStart(11, '0')), 124);
			bytes[156] = 48;
			bytes.set(data, 512);
			return bytes;
		});
		const compressed = new Uint8Array(gzipSync(Buffer.concat(members)));
		const input = dir({ '2026-01-05': { 'biome-streams.tar.gz': compressed } });
		const partial = await importBackups(input, { querySqlite });
		expect(Object.values(partial.focusEventsByDevice)[0]).toHaveLength(7);
		expect(partial.errors).toHaveLength(1);
		const api = server();
		const result = await syncBackups(input, { querySqlite, fetchFn: api.fetchFn, timeZone: 'UTC' });
		expect(result).toMatchObject({ imported: 0, failed: 1 });
		expect(result.errors).toEqual(partial.errors);
		expect(api.posts).toEqual([]);
	});
	it('does not complete a file after a rejected chunk', async () => {
		const api = server();
		const fetchFn: FetchFn = async (url, init) =>
			init?.body && JSON.parse(String(init.body)).action === 'chunk'
				? new Response('chunk rejected', { status: 500 })
				: api.fetchFn(url, init);
		const result = await syncBackups(dir({ '2026-01-05': { 'biome-streams.tar.gz': streams } }), {
			querySqlite,
			fetchFn,
			timeZone: 'UTC'
		});
		expect(result).toMatchObject({ imported: 0, failed: 1 });
		expect(result.errors[0]).toContain('chunk rejected');
		expect(api.posts.some((p) => p.action === 'complete')).toBe(false);
	});
	it('uses the ledger time zone and an injected transport base URL', async () => {
		const api = server();
		await syncBackups(dir({ '2026-01-05': { 'biome-streams.tar.gz': streams } }), {
			querySqlite,
			fetchFn: api.fetchFn,
			baseUrl: 'https://example.test/',
			timeZone: 'Europe/Paris'
		});
		expect(api.fetchFn.mock.calls[0][0]).toBe('https://example.test/api/imports');
		expect(api.posts[0].timeZone).toBe('UTC');
	});
	it('stops before uploading when cancelled after reading a file', async () => {
		const api = server();
		const controller = new AbortController();
		const input = dir({ '2026-01-05': { 'biome-streams.tar.gz': streams } });
		const result = await syncBackups(input, {
			querySqlite,
			fetchFn: api.fetchFn,
			timeZone: 'UTC',
			signal: controller.signal,
			onProgress: () => controller.abort()
		});
		expect(result.imported).toBe(0);
		expect(api.posts).toEqual([]);
		expect(result.errors.join(' ')).toMatch(/cancel/i);
		expect(result.failed).toBe(1);
	});
});

describe('chunkImportResult', () => {
	it('bounds UTF-8 request sizes, preserves all arrays and whole DeviceActivity segments', async () => {
		const scan = await importBackups(
			dir({
				'2026-01-05': { 'biome-streams.tar.gz': streams, 'device-activity.tar.gz': activity }
			}),
			{ querySqlite }
		);
		const device = Object.keys(scan.deviceActivityByDevice)[0];
		const segment = scan.deviceActivityByDevice[device][0];
		scan.deviceActivityByDevice[device] = Array.from({ length: 30 }, (_, i) => ({
			...segment,
			cocoaSeconds: segment.cocoaSeconds + i,
			entries: Array.from({ length: 700 }, () => ({ key: 'web:é.test', seconds: 123 }))
		}));
		scan.knowledgecSessionsByDevice.mac = Array.from({ length: 16000 }, () => ({
			bundleId: 'com.example.app',
			startMs: 1,
			endMs: 2
		}));
		const chunks = chunkImportResult(scan);
		expect(chunks.length).toBeGreaterThan(1);
		chunks.forEach((chunk) => {
			const records =
				Object.values(chunk.focusEventsByDevice).flat().length +
				Object.values(chunk.knowledgecSessionsByDevice).flat().length +
				Object.values(chunk.deviceActivityByDevice)
					.flat()
					.reduce((n, s) => n + 1 + s.entries.length, 0);
			expect(records).toBeLessThanOrEqual(2000);
		});
		chunks.forEach((chunk, index) =>
			expect(
				new TextEncoder().encode(
					JSON.stringify({ action: 'chunk', uploadId: 'some-upload-id', index, scan: chunk })
				).length
			).toBeLessThan(1_000_000)
		);
		for (const field of [
			'focusEventsByDevice',
			'knowledgecSessionsByDevice',
			'deviceActivityByDevice'
		] as const) {
			for (const [key, rows] of Object.entries(scan[field]))
				expect(chunks.flatMap<unknown>((c) => c[field][key] ?? [])).toEqual(rows);
		}
	});
	it('rejects an indivisible oversized segment', () => {
		const scan: ImportResult = {
			snapshots: ['2026-01-05'],
			errors: [],
			focusEventsByDevice: {},
			knowledgecSessionsByDevice: {},
			deviceActivityByDevice: {
				device: [{ cocoaSeconds: 1, entries: [{ key: 'x'.repeat(1_000_000), seconds: 1 }] }]
			}
		};
		expect(() => chunkImportResult(scan)).toThrow(/too large/i);
	});
});

it('adapts folder-picker paths without reading file contents eagerly', async () => {
	const file = Object.assign(new File([streams], 'biome-streams.tar.gz'), {
		webkitRelativePath: 'backups/2026-01-05/biome-streams.tar.gz'
	});
	const scan = await importBackups(filesToDir([file]), { querySqlite });
	expect(scan.snapshots).toEqual(['2026-01-05']);
	expect(Object.values(scan.focusEventsByDevice)[0]).toHaveLength(7);
});
