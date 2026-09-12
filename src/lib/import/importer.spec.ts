import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { importBackups, type DirLike } from './importer';

const COCOA = 978307200;
const cocoa = (iso: string): number => Date.parse(iso) / 1000 - COCOA;
const DEV = 'AAAAAAAA-1111-2222-3333-444444444444';

const streamsGz = new Uint8Array(
	readFileSync(new URL('../data/fixtures/streams.tar.gz', import.meta.url))
);
const deviceActivityGz = new Uint8Array(
	readFileSync(new URL('../data/fixtures/device-activity.tar.gz', import.meta.url))
);
const malformedDeviceActivityGz = (() => {
	const tar = new Uint8Array(gunzipSync(deviceActivityGz));
	const from = new TextEncoder().encode('categoryActivities');
	const to = new TextEncoder().encode('x'.repeat(from.length));
	for (let offset = 0; offset <= tar.length - from.length; offset++) {
		if (from.every((byte, index) => tar[offset + index] === byte)) tar.set(to, offset);
	}
	return new Uint8Array(gzipSync(tar));
})();
const emptyDeviceActivityGz = (() => {
	const tar = new Uint8Array(gunzipSync(deviceActivityGz));
	const categoryKey = new TextEncoder().encode('categoryActivities');
	let replacements = 0;
	for (let offset = 0; offset <= tar.length - categoryKey.length; offset++) {
		if (!categoryKey.every((byte, index) => tar[offset + index] === byte)) continue;
		// In this synthetic bplist fixture the category array marker follows its
		// key string by 42 bytes. Replacing A2 with A0 preserves a recognized empty array.
		expect(tar[offset + 42]).toBe(0xa2);
		tar[offset + 42] = 0xa0;
		replacements++;
	}
	expect(replacements).toBe(3);
	return new Uint8Array(gzipSync(tar));
})();
const DA_DEV = 'BBBBBBBB-1111-2222-3333-444444444444';

let SQL: SqlJsStatic;
let knowledgecGz: Uint8Array;

beforeAll(async () => {
	SQL = await initSqlJs();
	const db = new SQL.Database();
	db.run(
		'CREATE TABLE ZOBJECT (ZSTREAMNAME TEXT, ZVALUESTRING TEXT, ZSTARTDATE REAL, ZENDDATE REAL)'
	);
	db.run('INSERT INTO ZOBJECT VALUES (?, ?, ?, ?)', [
		'/app/usage',
		'com.example.macapp',
		cocoa('2026-01-05T15:00:00Z'),
		cocoa('2026-01-05T15:10:00Z')
	]);
	knowledgecGz = new Uint8Array(gzipSync(db.export()));
	db.close();
});

function fakeDir(entries: Record<string, Record<string, Uint8Array>>): DirLike {
	return {
		async *values() {
			for (const [dirName, files] of Object.entries(entries)) {
				yield {
					kind: 'directory' as const,
					name: dirName,
					async *values() {
						for (const [fileName, bytes] of Object.entries(files)) {
							yield {
								kind: 'file' as const,
								name: fileName,
								getFile: async () => ({
									arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer
								})
							};
						}
					}
				};
			}
		}
	};
}

describe('importBackups', () => {
	it('walks snapshots, decodes streams + knowledgeC, dedups across overlaps', async () => {
		const snapshot = {
			'biome-streams.tar.gz': streamsGz,
			'knowledgeC.db.gz': knowledgecGz,
			'device-activity.tar.gz': deviceActivityGz
		};
		const result = await importBackups(
			// second snapshot duplicates the first - dedup must collapse it
			fakeDir({ '2026-01-05': snapshot, '2026-01-12': snapshot, 'not-a-snapshot': {} }),
			{
				querySqlite: async (bytes, sql) => {
					const db = new SQL.Database(bytes);
					try {
						return db.exec(sql)[0]?.values ?? [];
					} finally {
						db.close();
					}
				}
			}
		);

		expect(result.snapshots).toEqual(['2026-01-05', '2026-01-12']);
		// live segment yields 7 events; tombstone + local are skipped by path
		expect(result.focusEventsByDevice[DEV]).toHaveLength(14); // 7 x 2 snapshots, deduped later
		expect(result.knowledgecSessionsByDevice['knowledgec']).toHaveLength(2);
		// Daily and Hourly are distinct even when their timestamps collide. The
		// duplicate snapshot's copy of each granularity overwrites the earlier copy.
		expect(result.deviceActivityByDevice[DA_DEV]).toHaveLength(2);
		const daily = result.deviceActivityByDevice[DA_DEV].find((segment) => !segment.hourly)!;
		const hourly = result.deviceActivityByDevice[DA_DEV].find((segment) => segment.hourly)!;
		expect(daily.cocoaSeconds).toBe(809409600);
		expect(daily.entries).toContainEqual({
			key: 'web:example-movies.test',
			seconds: 3558.5
		});
		expect(hourly).toMatchObject({
			cocoaSeconds: 809409600,
			hourly: true,
			entries: expect.arrayContaining([{ key: 'web:example-movies.test', seconds: 3558.5 }])
		});
		expect(result.errors).toEqual([]);
	});

	it('records a per-snapshot error instead of failing the whole import', async () => {
		const result = await importBackups(
			fakeDir({ '2026-01-05': { 'biome-streams.tar.gz': new Uint8Array([1, 2, 3]) } }),
			{
				querySqlite: async (bytes, sql) => {
					const db = new SQL.Database(bytes);
					try {
						return db.exec(sql)[0]?.values ?? [];
					} finally {
						db.close();
					}
				}
			}
		);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain('2026-01-05');
	});

	it('retains newer empty daily and hourly segments so they clear stale copies', async () => {
		const result = await importBackups(
			fakeDir({
				'2026-01-05': { 'device-activity.tar.gz': deviceActivityGz },
				'2026-01-12': { 'device-activity.tar.gz': emptyDeviceActivityGz }
			}),
			{ querySqlite: async () => [] }
		);
		expect(result.errors).toEqual([]);
		expect(result.deviceActivityByDevice[DA_DEV]).toEqual([
			{ cocoaSeconds: 809409600, entries: [] },
			{ cocoaSeconds: 809409600, hourly: true, entries: [] }
		]);
	});

	it('rejects valid plists with an unrecognized ActivitySegment shape without replacing prior data', async () => {
		const result = await importBackups(
			fakeDir({
				'2026-01-05': { 'device-activity.tar.gz': deviceActivityGz },
				'2026-01-12': { 'device-activity.tar.gz': malformedDeviceActivityGz }
			}),
			{ querySqlite: async () => [] }
		);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatch(/unrecognized ActivitySegment/i);
		expect(result.deviceActivityByDevice[DA_DEV]).toHaveLength(2);
		for (const segment of result.deviceActivityByDevice[DA_DEV]) {
			expect(segment.entries).not.toEqual([]);
		}
	});
});

describe('importBackups error reporting', () => {
	it('names the file and never reports a blank reason', async () => {
		const truncated = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]); // gzip header, no body
		const result = await importBackups(
			fakeDir({ '2026-01-05': { 'biome-streams.tar.gz': truncated } }),
			{ querySqlite: async () => [] }
		);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatch(/^2026-01-05\/biome-streams\.tar\.gz: .+/);
	});
});
