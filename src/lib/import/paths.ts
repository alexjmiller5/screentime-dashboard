// Pure classification helpers for the import walker.

import type { FocusEvent } from '../data/infocus';

export interface DeviceActivityFile {
	device: string;
	/** Segment day start, Cocoa seconds (from the filename). */
	cocoaSeconds: number;
}

/**
 * Classify a path inside device-activity.tar.gz. Only Cloud per-device DAILY
 * segments carry the cross-device Screen Time aggregates (apps + web
 * domains); Hourly is redundant detail and Local/ is sparse metadata.
 */
export function classifyDeviceActivityFile(path: string): DeviceActivityFile | null {
	const match =
		/^com\.apple\.DeviceActivity\/Cloud\/[^/]+\/([0-9A-Fa-f-]{36})\/Daily\/ActivitySegments\/([0-9.]+)\.plist$/.exec(
			path
		);
	return match ? { device: match[1], cocoaSeconds: Number(match[2]) } : null;
}

/**
 * Best-effort platform guess from a device's event content. Real device names
 * exist only in Screen Time's RMAdminStore under a different (unjoinable)
 * identity namespace, so the shell surfaces in the stream are the tell:
 * SpringBoard = iOS, Finder/loginwindow = macOS.
 */
export function guessDeviceLabel(events: FocusEvent[]): 'iPhone' | 'Mac' | null {
	for (const e of events) {
		const b = e.bundleId.toLowerCase();
		if (b.startsWith('com.apple.springboard')) return 'iPhone';
		if (b === 'com.apple.finder' || b === 'com.apple.loginwindow') return 'Mac';
	}
	return null;
}

/** Snapshot dirs are date-named: 2026-08-23, 2026-07-05-0008, *-macbook-seed… */
export function isSnapshotDirName(name: string): boolean {
	return /^\d{4}-\d{2}-\d{2}(-.+)?$/.test(name);
}

export type StreamFileKind = { kind: 'infocus-remote'; device: string };

/**
 * Classify a path inside biome-streams.tar.gz. Only remote App.InFocus
 * segments carry cross-device usage events; tombstone/ files are deletion
 * bookkeeping, local/ is the writing machine's own (empty on the mini).
 */
export function classifyStreamFile(path: string): StreamFileKind | null {
	const match = /^App\.InFocus\/remote\/([0-9A-Fa-f-]{36})\/[^/]+$/.exec(path);
	return match ? { kind: 'infocus-remote', device: match[1] } : null;
}
