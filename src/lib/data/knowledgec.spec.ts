import { describe, expect, it, beforeAll } from 'vitest';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { extractAppUsageSessions } from './knowledgec';

const COCOA = 978307200;
const cocoa = (iso: string): number => Date.parse(iso) / 1000 - COCOA;

let SQL: SqlJsStatic;
let dbBytes: Uint8Array;

beforeAll(async () => {
	SQL = await initSqlJs();
	const db = new SQL.Database();
	db.run(`CREATE TABLE ZOBJECT (
		Z_PK INTEGER PRIMARY KEY,
		ZSTREAMNAME TEXT,
		ZVALUESTRING TEXT,
		ZSTARTDATE REAL,
		ZENDDATE REAL
	)`);
	const insert = db.prepare(
		'INSERT INTO ZOBJECT (ZSTREAMNAME, ZVALUESTRING, ZSTARTDATE, ZENDDATE) VALUES (?, ?, ?, ?)'
	);
	insert.run([
		'/app/usage',
		'com.example.a',
		cocoa('2026-01-05T15:00:00Z'),
		cocoa('2026-01-05T15:10:00Z')
	]);
	insert.run([
		'/app/usage',
		'com.example.b',
		cocoa('2026-01-05T16:00:00Z'),
		cocoa('2026-01-05T16:00:45Z')
	]);
	insert.run([
		'/app/intents',
		'com.example.ignored',
		cocoa('2026-01-05T15:00:00Z'),
		cocoa('2026-01-05T18:00:00Z')
	]);
	insert.run(['/app/usage', null, cocoa('2026-01-05T15:00:00Z'), cocoa('2026-01-05T15:10:00Z')]);
	insert.free();
	dbBytes = db.export();
	db.close();
});

describe('extractAppUsageSessions', () => {
	it('extracts /app/usage rows as absolute sessions in Unix ms', () => {
		expect(extractAppUsageSessions(SQL, dbBytes)).toEqual([
			{
				bundleId: 'com.example.a',
				startMs: Date.parse('2026-01-05T15:00:00Z'),
				endMs: Date.parse('2026-01-05T15:10:00Z')
			},
			{
				bundleId: 'com.example.b',
				startMs: Date.parse('2026-01-05T16:00:00Z'),
				endMs: Date.parse('2026-01-05T16:00:45Z')
			}
		]);
	});
});
