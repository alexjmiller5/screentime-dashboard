import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
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
			{ initSql: async () => SQL }
		);

		expect(result.snapshots).toEqual(['2026-01-05', '2026-01-12']);
		// live segment yields 7 events; tombstone + local are skipped by path
		expect(result.focusEventsByDevice[DEV]).toHaveLength(14); // 7 x 2 snapshots, deduped later
		expect(result.knowledgecSessionsByDevice['knowledgec']).toHaveLength(2);
		// Cloud Daily segment parsed once - the duplicate snapshot's copy of the
		// same (device, day) OVERWRITES rather than duplicates; Hourly/Local ignored
		expect(result.deviceActivityByDevice[DA_DEV]).toHaveLength(1);
		expect(result.deviceActivityByDevice[DA_DEV][0].cocoaSeconds).toBe(809409600);
		expect(result.deviceActivityByDevice[DA_DEV][0].entries).toContainEqual({
			key: 'web:example-movies.test',
			seconds: 3558.5
		});
		expect(result.errors).toEqual([]);
	});

	it('records a per-snapshot error instead of failing the whole import', async () => {
		const result = await importBackups(
			fakeDir({ '2026-01-05': { 'biome-streams.tar.gz': new Uint8Array([1, 2, 3]) } }),
			{ initSql: async () => SQL }
		);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain('2026-01-05');
	});
});
