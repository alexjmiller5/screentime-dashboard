// Import orchestrator: walk the backups folder, decode every snapshot
// client-side, and return the raw material for buildUsageCache. Works on any
// DirLike - the browser's FileSystemDirectoryHandle satisfies it structurally.

import type { SqlJsStatic } from 'sql.js';
import { parseSegb } from '../data/segb';
import { extractFocusEvents, type FocusEvent } from '../data/infocus';
import { extractAppUsageSessions } from '../data/knowledgec';
import type { UsageSession } from '../data/intervals';
import { untar } from '../data/tar';
import { gunzip } from './gunzip';
import { isSnapshotDirName, classifyStreamFile } from './paths';

/** knowledgeC has no device field - it belongs to whichever Mac wrote the
 * snapshot. Attributed to this pseudo-device; labeled in the UI like any other. */
export const KNOWLEDGEC_DEVICE = 'knowledgec';

export interface FileLike {
	kind: 'file';
	name: string;
	getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
}
export interface DirLike {
	kind?: 'directory';
	name?: string;
	values(): AsyncIterable<FileLike | DirLike>;
}

export interface ImportResult {
	snapshots: string[];
	errors: string[];
	focusEventsByDevice: Record<string, FocusEvent[]>;
	knowledgecSessionsByDevice: Record<string, UsageSession[]>;
}

export interface ImportOptions {
	initSql: () => Promise<SqlJsStatic>;
	onProgress?: (message: string) => void;
}

async function readEntry(entry: FileLike): Promise<Uint8Array> {
	return new Uint8Array(await (await entry.getFile()).arrayBuffer());
}

export async function importBackups(dir: DirLike, options: ImportOptions): Promise<ImportResult> {
	const result: ImportResult = {
		snapshots: [],
		errors: [],
		focusEventsByDevice: {},
		knowledgecSessionsByDevice: {}
	};
	let SQL: SqlJsStatic | null = null;

	const snapshotDirs: DirLike[] = [];
	for await (const entry of dir.values()) {
		if (entry.kind === 'directory' && entry.name && isSnapshotDirName(entry.name)) {
			snapshotDirs.push(entry);
		}
	}
	snapshotDirs.sort((a, b) => a.name!.localeCompare(b.name!));

	for (const snapshot of snapshotDirs) {
		const name = snapshot.name!;
		result.snapshots.push(name);
		options.onProgress?.(`reading ${name}…`);
		try {
			for await (const entry of snapshot.values()) {
				if (entry.kind !== 'file') continue;
				if (entry.name === 'biome-streams.tar.gz') {
					for (const file of untar(await gunzip(await readEntry(entry)))) {
						const classified = classifyStreamFile(file.name);
						if (!classified) continue;
						const events = extractFocusEvents(parseSegb(file.data));
						(result.focusEventsByDevice[classified.device] ??= []).push(...events);
					}
				} else if (entry.name === 'knowledgeC.db.gz') {
					SQL ??= await options.initSql();
					const sessions = extractAppUsageSessions(SQL, await gunzip(await readEntry(entry)));
					(result.knowledgecSessionsByDevice[KNOWLEDGEC_DEVICE] ??= []).push(...sessions);
				}
			}
		} catch (error) {
			result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return result;
}
