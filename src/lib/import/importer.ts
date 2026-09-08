// Import orchestrator: walk the backups folder, decode every snapshot, and
// return the raw material for buildUsageCache. Works on any DirLike - the
// ingest CLI's filesystem adapter, or a browser FileSystemDirectoryHandle.

import { parseSegb } from '../data/segb';
import { extractFocusEvents, type FocusEvent } from '../data/infocus';
import { APP_USAGE_SQL, extractAppUsageSessions } from '../data/knowledgec';
import type { UsageSession } from '../data/intervals';
import { untar } from '../data/tar';
import { parseBplist } from '../data/bplist';
import {
	extractSegmentActivities,
	type ActivityEntry,
	type DeviceSegment
} from '../data/deviceactivity';
import { gunzip } from './gunzip';
import { isSnapshotDirName, classifyStreamFile, classifyDeviceActivityFile } from './paths';

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
	/** One segment per (device, day); later snapshots overwrite earlier
	 * (their copy of a still-open day is more complete). */
	deviceActivityByDevice: Record<string, DeviceSegment[]>;
}

export interface ImportOptions {
	/** Run one SQL query against a SQLite database image; rows as arrays. */
	querySqlite: (dbBytes: Uint8Array, sql: string) => Promise<unknown[][]>;
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
		knowledgecSessionsByDevice: {},
		deviceActivityByDevice: {}
	};
	// (device, day) -> entries; snapshots walk in chronological order, so a
	// later snapshot's copy of the same day overwrites the earlier partial one.
	const segmentEntries = new Map<string, ActivityEntry[]>();

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
		for await (const entry of snapshot.values()) {
			if (entry.kind !== 'file') continue;
			// One unreadable file loses that file, never the snapshot's other files.
			try {
				if (entry.name === 'biome-streams.tar.gz') {
					for (const file of untar(await gunzip(await readEntry(entry)))) {
						const classified = classifyStreamFile(file.name);
						if (!classified) continue;
						const events = extractFocusEvents(parseSegb(file.data));
						(result.focusEventsByDevice[classified.device] ??= []).push(...events);
					}
				} else if (entry.name === 'knowledgeC.db.gz') {
					const rows = await options.querySqlite(
						await gunzip(await readEntry(entry)),
						APP_USAGE_SQL
					);
					const sessions = extractAppUsageSessions(rows);
					(result.knowledgecSessionsByDevice[KNOWLEDGEC_DEVICE] ??= []).push(...sessions);
				} else if (entry.name === 'device-activity.tar.gz') {
					for (const file of untar(await gunzip(await readEntry(entry)))) {
						const classified = classifyDeviceActivityFile(file.name);
						if (!classified) continue;
						const entries = extractSegmentActivities(parseBplist(file.data));
						if (entries.length > 0) {
							segmentEntries.set(`${classified.device}|${classified.cocoaSeconds}`, entries);
						}
					}
				}
			} catch (error) {
				result.errors.push(
					`${name}/${entry.name}: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
	}

	for (const [key, entries] of segmentEntries) {
		const [device, cocoa] = key.split('|');
		(result.deviceActivityByDevice[device] ??= []).push({
			cocoaSeconds: Number(cocoa),
			entries
		});
	}
	return result;
}
