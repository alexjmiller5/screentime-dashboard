import {
	importBackups,
	type DirLike,
	type FileLike,
	type ImportOptions,
	type ImportResult
} from './importer';
import type { DeviceSegment } from '../data/deviceactivity';
import { isSnapshotDirName } from './paths';

/** Bump whenever parsing semantics change so unchanged files are reprocessed. */
export const PARSER_VERSION = 1;
const FILENAMES = new Set(['biome-streams.tar.gz', 'knowledgeC.db.gz', 'device-activity.tar.gz']);
const encoder = new TextEncoder();
const byteSize = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SyncOptions extends ImportOptions {
	fetchFn?: FetchFn;
	baseUrl?: string;
	timeZone: string;
	force?: boolean;
	signal?: AbortSignal;
}
export interface SyncResult {
	imported: number;
	skipped: number;
	/** Failed files/directories plus fatal run errors, including cancellation. */
	failed: number;
	errors: string[];
}
interface LedgerFile {
	path: string;
	hash: string;
	parserVersion: number;
}

/** Keep segments whole: splitting their entries would make later chunks overwrite them.
 * Leave room for the transport envelope; the final request is also byte-checked. */
export function chunkImportResult(scan: ImportResult): ImportResult[] {
	const empty = (): ImportResult => ({
		snapshots: scan.snapshots,
		errors: [],
		focusEventsByDevice: {},
		knowledgecSessionsByDevice: {},
		deviceActivityByDevice: {}
	});
	const chunks: ImportResult[] = [];
	let chunk = empty();
	let size = byteSize(chunk);
	let records = 0;
	const emptySize = size;
	const limit = 900_000;
	if (size >= limit) throw new Error('Snapshot metadata is too large to upload');
	for (const field of [
		'focusEventsByDevice',
		'knowledgecSessionsByDevice',
		'deviceActivityByDevice'
	] as const) {
		for (const [device, rows] of Object.entries(scan[field])) {
			for (const row of rows) {
				// Counting a key for every row overestimates size, safely, without repeatedly
				// serializing a growing chunk (quadratic on large knowledgeC databases).
				const added = byteSize(device) + byteSize(row) + 4;
				const rowRecords =
					field === 'deviceActivityByDevice' ? 1 + (row as DeviceSegment).entries.length : 1;
				if (emptySize + added >= limit || rowRecords > 2000)
					throw new Error(`${field}/${device}: record or segment is too large to upload intact`);
				if (size + added >= limit || records + rowRecords > 2000) {
					chunks.push(chunk);
					chunk = empty();
					size = emptySize;
					records = 0;
				}
				const target = chunk[field] as Record<string, unknown[]>;
				(target[device] ??= []).push(row);
				size += added;
				records += rowRecords;
			}
		}
	}
	chunks.push(chunk);
	return chunks;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message || error.name : String(error);
}

export async function syncBackups(dir: DirLike, options: SyncOptions): Promise<SyncResult> {
	const result: SyncResult = { imported: 0, skipped: 0, failed: 0, errors: [] };
	const fetchFn = options.fetchFn ?? fetch;
	const endpoint = `${(options.baseUrl ?? '').replace(/\/$/, '')}/api/imports`;
	const checkCancelled = (): void => {
		options.signal?.throwIfAborted();
	};
	async function request(body?: unknown): Promise<Response> {
		checkCancelled();
		const serialized = body === undefined ? undefined : JSON.stringify(body);
		if (serialized && encoder.encode(serialized).length >= 1_000_000)
			throw new Error('Upload request is too large (must be under 1 MB)');
		const response = await fetchFn(endpoint, {
			...(serialized
				? { method: 'POST', headers: { 'content-type': 'application/json' }, body: serialized }
				: {}),
			signal: options.signal
		});
		if (!response.ok)
			throw new Error(`Import request failed (${response.status}): ${await response.text()}`);
		return response;
	}
	try {
		const ledger = (await (await request()).json()) as { files: LedgerFile[]; timeZone?: string };
		if (!Array.isArray(ledger.files)) throw new Error('Invalid import ledger response');
		const known = new Set(
			ledger.files.map((f) => JSON.stringify([f.path, f.hash, f.parserVersion]))
		);
		const timeZone = ledger.timeZone ?? options.timeZone;
		new Intl.DateTimeFormat('en', { timeZone });
		const snapshots: DirLike[] = [];
		for await (const entry of dir.values()) {
			checkCancelled();
			if (entry.kind === 'directory' && entry.name && isSnapshotDirName(entry.name))
				snapshots.push(entry);
		}
		snapshots.sort((a, b) => a.name!.localeCompare(b.name!));
		let found = 0;
		for (const snapshot of snapshots) {
			checkCancelled();
			const files: FileLike[] = [];
			try {
				for await (const entry of snapshot.values())
					if (entry.kind === 'file' && FILENAMES.has(entry.name)) files.push(entry);
			} catch (error) {
				result.failed++;
				result.errors.push(`${snapshot.name}: ${describe(error)}`);
				continue;
			}
			files.sort((a, b) => a.name.localeCompare(b.name));
			for (const file of files) {
				checkCancelled();
				found++;
				const path = `${snapshot.name}/${file.name}`;
				options.onProgress?.(`Checking ${path}`);
				try {
					checkCancelled();
					const bytes = await (await file.getFile()).arrayBuffer();
					const hash = Array.from(
						new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
						(b) => b.toString(16).padStart(2, '0')
					).join('');
					checkCancelled();
					if (!options.force && known.has(JSON.stringify([path, hash, PARSER_VERSION]))) {
						result.skipped++;
						continue;
					}
					const single: DirLike = {
						async *values() {
							yield {
								kind: 'directory' as const,
								name: snapshot.name,
								async *values() {
									yield {
										kind: 'file' as const,
										name: file.name,
										getFile: async () => ({ arrayBuffer: async () => bytes })
									};
								}
							};
						}
					};
					options.onProgress?.(`Parsing ${path}`);
					const scan = await importBackups(single, { querySqlite: options.querySqlite });
					checkCancelled();
					if (scan.errors.length) {
						result.failed++;
						result.errors.push(...scan.errors);
						continue;
					}
					const chunks = chunkImportResult(scan);
					const { uploadId } = (await (
						await request({ action: 'begin', path, hash, parserVersion: PARSER_VERSION, timeZone })
					).json()) as { uploadId: string };
					if (typeof uploadId !== 'string' || !uploadId) throw new Error('Invalid upload ID');
					for (let index = 0; index < chunks.length; index++) {
						options.onProgress?.(`Uploading ${path} (${index + 1}/${chunks.length})`);
						await request({ action: 'chunk', uploadId, index, scan: chunks[index] });
					}
					await request({ action: 'complete', uploadId, chunks: chunks.length });
					result.imported++;
				} catch (error) {
					if (options.signal?.aborted) throw error;
					result.failed++;
					result.errors.push(`${path}: ${describe(error)}`);
				}
			}
		}
		if (!found && !result.failed)
			throw new Error(
				'No supported backup files found. Choose the folder containing dated snapshot folders.'
			);
	} catch (error) {
		result.failed++;
		result.errors.push(
			options.signal?.aborted
				? 'Import cancelled. Previously completed files are kept; unfinished files will be retried next time.'
				: describe(error)
		);
	}
	options.onProgress?.(
		`${result.imported} imported, ${result.skipped} skipped, ${result.failed} failed`
	);
	return result;
}
