import type { ImportResult } from '../import/importer';
import type { DeviceSegment } from '../data/deviceactivity';
import { isSnapshotDirName } from '../import/paths';

export const MAX_IMPORT_BYTES = 1024 * 1024;
const MAX_CHUNKS = 10000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_RECORDS = 10000;
// A row is a parsed event, session, segment header or activity, never an archive.
type RecordRow = [string, string, number, string | null, number | null, number?];
export class ImportError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}
function requireValid(condition: unknown, message = 'invalid import payload'): asserts condition {
	if (!condition) throw new ImportError(400, message);
}
function object(value: unknown): Record<string, unknown> {
	requireValid(value !== null && typeof value === 'object' && !Array.isArray(value));
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 512): string {
	requireValid(
		typeof value === 'string' &&
			value.length > 0 &&
			value.length <= max &&
			!/[\x00-\x1f|]/.test(value)
	);
	return value;
}
function integer(value: unknown, max: number): number {
	requireValid(typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max);
	return value;
}
function number(value: unknown, min = 0, max = 8640000000000000): number {
	requireValid(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max);
	return value;
}
function identifier(value: unknown): string {
	const key = text(value);
	requireValid(!['__proto__', 'constructor', 'prototype'].includes(key));
	return key;
}
function array(value: unknown): unknown[] {
	requireValid(Array.isArray(value) && value.length <= MAX_RECORDS);
	return value;
}
function recordsFromScan(input: unknown): RecordRow[] {
	const scan = object(input);
	for (const snapshot of array(scan.snapshots))
		requireValid(isSnapshotDirName(text(snapshot, 255)));
	requireValid(array(scan.errors).length === 0, 'cannot commit a scan with parse errors');
	const rows: RecordRow[] = [];
	const add = (row: RecordRow) => {
		if (rows.length >= MAX_RECORDS) throw new ImportError(413, 'too many parsed records');
		rows.push(row);
	};
	for (const field of [
		'focusEventsByDevice',
		'knowledgecSessionsByDevice',
		'deviceActivityByDevice'
	]) {
		for (const [key, values] of Object.entries(object(scan[field])).sort(([a], [b]) =>
			a.localeCompare(b)
		)) {
			const device = identifier(key);
			for (const value of array(values)) {
				const record = object(value);
				if (field === 'focusEventsByDevice') {
					requireValid(typeof record.focus === 'boolean');
					add(['focus', device, number(record.tsMs), text(record.bundleId), Number(record.focus)]);
				} else if (field === 'knowledgecSessionsByDevice') {
					const start = number(record.startMs);
					const end = number(record.endMs);
					requireValid(end >= start && end - start <= 366 * 86400000, 'invalid session interval');
					add(['session', device, start, text(record.bundleId), end]);
				} else {
					const timestamp = number(record.cocoaSeconds, -978307200, 8639999021692);
					const segmentOrdinal = rows.length;
					add(['segment', device, timestamp, null, null]);
					for (const value of array(record.entries)) {
						const entry = object(value);
						add([
							'activity',
							device,
							timestamp,
							text(entry.key),
							number(entry.seconds, 0, 366 * 86400),
							segmentOrdinal
						]);
					}
				}
			}
		}
	}
	return rows;
}

type Upload = {
	id: string;
	path: string;
	hash: string;
	parser_version: number;
	time_zone: string;
	completed_chunks: number | null;
};
async function getUpload(db: D1Database, id: string): Promise<Upload> {
	const upload = await db
		.prepare('SELECT * FROM import_uploads WHERE id = ?')
		.bind(id)
		.first<Upload>();
	if (!upload) throw new ImportError(404, 'unknown upload');
	return upload;
}
export async function readImportLedger(db: D1Database) {
	const result = await db
		.prepare(
			`SELECT f.path, u.hash, u.parser_version AS parserVersion
  FROM import_files f JOIN import_uploads u ON u.id = f.upload_id ORDER BY f.path`
		)
		.all();
	const timeZone = await db
		.prepare("SELECT value FROM meta WHERE key = 'time_zone'")
		.first<string>('value');
	return { files: result.results, ...(timeZone ? { timeZone } : {}) };
}

export async function importAction(
	db: D1Database,
	input: unknown
): Promise<{ uploadId: string } | void> {
	const body = object(input);
	if (body.action === 'begin') {
		const path = text(body.path, 1024);
		const parts = path.split('/');
		requireValid(
			parts.length === 2 &&
				isSnapshotDirName(parts[0]) &&
				!/[\\]/.test(path) &&
				['biome-streams.tar.gz', 'knowledgeC.db.gz', 'device-activity.tar.gz'].includes(parts[1]),
			'invalid snapshot file path'
		);
		const hash = text(body.hash, 64);
		requireValid(/^[a-f0-9]{64}$/.test(hash), 'hash must be lowercase SHA-256');
		const parserVersion = integer(body.parserVersion, 2147483647);
		requireValid(parserVersion > 0, 'parserVersion must be positive');
		const timeZone = text(body.timeZone, 128);
		try {
			new Intl.DateTimeFormat('en', { timeZone });
		} catch {
			throw new ImportError(400, 'invalid timeZone');
		}
		const uploadId = crypto.randomUUID();
		await db.batch([
			// Reap at most ten inactive uploads per begin; cascades remove their
			// chunks and records. Current ledger contributions never expire.
			db.prepare(`DELETE FROM import_uploads WHERE id IN (
    SELECT u.id FROM import_uploads u
    WHERE u.updated_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
     AND NOT EXISTS (SELECT 1 FROM import_files f WHERE f.upload_id = u.id)
    ORDER BY u.updated_at,u.id LIMIT 10)`),
			db
				.prepare(
					`INSERT INTO import_uploads (id,path,hash,parser_version,time_zone,previous_id)
   VALUES (?,?,?,?,?,(SELECT upload_id FROM import_files WHERE path = ?))`
				)
				.bind(uploadId, path, hash, parserVersion, timeZone, path)
		]);
		return { uploadId };
	}
	requireValid(body.action === 'chunk' || body.action === 'complete', 'unknown action');
	const id = text(body.uploadId, 36);
	requireValid(
		/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id),
		'invalid uploadId'
	);
	if (body.action === 'chunk') {
		const index = integer(body.index, MAX_CHUNKS - 1);
		const records = JSON.stringify(recordsFromScan(body.scan));
		const encoded = new TextEncoder().encode(records);
		// Flattening repeats device IDs; keep the SQL binding below D1's 2 MiB value limit.
		if (encoded.byteLength >= 2 * MAX_IMPORT_BYTES)
			throw new ImportError(413, 'parsed chunk too large');
		const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoded)), (b) =>
			b.toString(16).padStart(2, '0')
		).join('');
		await getUpload(db, id);
		await db.batch([
			db
				.prepare(
					`INSERT INTO import_chunks (upload_id,chunk_index,digest,bytes)
    SELECT id,?,?,? FROM import_uploads WHERE id = ? AND completed_chunks IS NULL
     AND COALESCE((SELECT SUM(bytes) FROM import_chunks WHERE upload_id = ?),0) + ? <= ?
    ON CONFLICT (upload_id,chunk_index) DO NOTHING`
				)
				.bind(index, digest, encoded.byteLength, id, id, encoded.byteLength, MAX_FILE_BYTES),
			db
				.prepare(
					`INSERT INTO import_records (upload_id,chunk_index,ordinal,kind,device,timestamp,bundle_id,value,segment_ordinal)
    SELECT c.upload_id,c.chunk_index,j.key,json_extract(j.value,'$[0]'),json_extract(j.value,'$[1]'),
     json_extract(j.value,'$[2]'),json_extract(j.value,'$[3]'),json_extract(j.value,'$[4]'),json_extract(j.value,'$[5]')
    FROM import_chunks c JOIN import_uploads u ON u.id = c.upload_id, json_each(?) j
    WHERE c.upload_id = ? AND c.chunk_index = ? AND c.digest = ? AND u.completed_chunks IS NULL
    ON CONFLICT (upload_id,chunk_index,ordinal) DO NOTHING`
				)
				.bind(records, id, index, digest),
			db
				.prepare(
					`UPDATE import_uploads SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND EXISTS (SELECT 1 FROM import_chunks
     WHERE upload_id = ? AND chunk_index = ? AND digest = ?)`
				)
				.bind(id, id, index, digest)
		]);
		const existing = await db
			.prepare('SELECT digest FROM import_chunks WHERE upload_id = ? AND chunk_index = ?')
			.bind(id, index)
			.first<string>('digest');
		if (existing !== digest)
			throw new ImportError(409, 'chunk conflicts, upload is closed, or file size limit exceeded');
		return;
	}
	const count = integer(body.chunks, MAX_CHUNKS);
	requireValid(count > 0, 'at least one validated chunk is required');
	const upload = await getUpload(db, id);
	if (upload.completed_chunks !== null) {
		if (upload.completed_chunks !== count)
			throw new ImportError(409, 'completion chunk count differs');
		return;
	}
	// The compare-and-swap and exact count check occur in SQL, inside the same
	// transaction that freezes chunks and stamps metadata. No read/write race.
	const result = await db.batch([
		db
			.prepare(
				`INSERT INTO import_files (path,upload_id)
   SELECT u.path,u.id FROM import_uploads u WHERE u.id = ? AND u.completed_chunks IS NULL
    AND u.previous_id IS (SELECT upload_id FROM import_files WHERE path = u.path)
    AND NOT EXISTS (SELECT 1 FROM meta WHERE key = 'time_zone' AND value != u.time_zone)
    AND (SELECT COUNT(*) FROM import_chunks WHERE upload_id = u.id) = ?
    AND NOT EXISTS (SELECT 1 FROM import_chunks WHERE upload_id = u.id AND chunk_index >= ?)
   ON CONFLICT (path) DO UPDATE SET upload_id = excluded.upload_id`
			)
			.bind(id, count, count),
		db
			.prepare(
				`UPDATE import_uploads SET completed_chunks = ? WHERE id = ? AND completed_chunks IS NULL
   AND EXISTS (SELECT 1 FROM import_files WHERE upload_id = ?)`
			)
			.bind(count, id, id),
		db
			.prepare(
				`INSERT INTO meta (key,value) SELECT 'time_zone',time_zone FROM import_uploads
   WHERE id = ? AND EXISTS (SELECT 1 FROM import_files WHERE upload_id = ?)
   ON CONFLICT (key) DO UPDATE SET value = excluded.value`
			)
			.bind(id, id),
		db
			.prepare(
				`INSERT INTO meta (key,value) SELECT 'data_updated_at',strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE EXISTS (SELECT 1 FROM import_files WHERE upload_id = ?)
   ON CONFLICT (key) DO UPDATE SET value = excluded.value`
			)
			.bind(id),
		db
			.prepare(
				`DELETE FROM import_records WHERE upload_id = (SELECT previous_id FROM import_uploads WHERE id = ?)
   AND EXISTS (SELECT 1 FROM import_files WHERE upload_id = ?)`
			)
			.bind(id, id)
	]);
	if (!result[0].meta.changes) {
		// A simultaneous identical completion is also a successful retry.
		if ((await getUpload(db, id)).completed_chunks === count) return;
		throw new ImportError(
			409,
			'incomplete chunks, stale file version, or timezone conflict; read the ledger and begin a new upload'
		);
	}
}

export async function readImportedScan(db: D1Database): Promise<ImportResult> {
	const result: ImportResult = {
		snapshots: [],
		errors: [],
		focusEventsByDevice: Object.create(null),
		knowledgecSessionsByDevice: Object.create(null),
		deviceActivityByDevice: Object.create(null)
	};
	// SQL returns only distinct events/sessions and winning segments. Window ranking
	// preserves the first occurrence order for equal-time focus transitions.
	const rows = await db
		.prepare(
			`WITH ranked_events AS (
   SELECT f.path,r.*,ROW_NUMBER() OVER (
    PARTITION BY r.kind,r.device,r.timestamp,r.bundle_id,r.value
    ORDER BY f.path,r.chunk_index,r.ordinal) AS rank
   FROM import_files f JOIN import_records r ON r.upload_id = f.upload_id
   WHERE r.kind IN ('focus','session')
  ), ranked_segments AS (
   SELECT f.path,r.*,ROW_NUMBER() OVER (
    PARTITION BY r.device,r.timestamp
    ORDER BY f.path DESC,r.chunk_index DESC,r.ordinal DESC) AS rank
   FROM import_files f JOIN import_records r ON r.upload_id = f.upload_id WHERE r.kind = 'segment'
  ), selected AS (
   SELECT path,kind,device,timestamp,bundle_id,value,chunk_index,ordinal FROM ranked_events WHERE rank = 1
   UNION ALL
   SELECT path,kind,device,timestamp,bundle_id,value,chunk_index,ordinal FROM ranked_segments WHERE rank = 1
   UNION ALL
   SELECT s.path,r.kind,r.device,r.timestamp,r.bundle_id,r.value,r.chunk_index,r.ordinal
   FROM ranked_segments s JOIN import_records r ON r.upload_id = s.upload_id AND r.chunk_index = s.chunk_index
    AND r.segment_ordinal = s.ordinal WHERE s.rank = 1
   UNION ALL
   SELECT path,NULL,NULL,NULL,NULL,NULL,-1,-1 FROM import_files
  ) SELECT path,kind,device,timestamp,bundle_id,value FROM selected ORDER BY path,chunk_index,ordinal`
		)
		.all<{
			path: string;
			kind: string | null;
			device: string;
			timestamp: number;
			bundle_id: string;
			value: number;
		}>();
	const snapshots = new Set<string>();
	const segments = new Map<string, Map<number, DeviceSegment>>();
	for (const row of rows.results) {
		snapshots.add(row.path.split('/')[0]);
		if (row.kind === 'focus') {
			(result.focusEventsByDevice[row.device] ??= []).push({
				tsMs: row.timestamp,
				bundleId: row.bundle_id,
				focus: !!row.value
			});
		} else if (row.kind === 'session') {
			(result.knowledgecSessionsByDevice[row.device] ??= []).push({
				startMs: row.timestamp,
				endMs: row.value,
				bundleId: row.bundle_id
			});
		} else if (row.kind === 'segment') {
			if (!segments.has(row.device)) segments.set(row.device, new Map());
			segments.get(row.device)!.set(row.timestamp, { cocoaSeconds: row.timestamp, entries: [] });
		} else if (row.kind === 'activity') {
			segments
				.get(row.device)!
				.get(row.timestamp)!
				.entries.push({ key: row.bundle_id, seconds: row.value });
		}
	}
	result.snapshots = [...snapshots];
	for (const [device, values] of segments)
		result.deviceActivityByDevice[device] = [...values.values()];
	return result;
}
