// DeviceActivity ActivitySegments -> usage rows. These are Apple's own
// cross-device Screen Time aggregates (what the Settings pane renders):
// per-device daily plists with per-app durations AND per-web-domain durations
// (WebKit reports every iOS browser, so this is where "time at youtube.com
// in Chrome on the iPhone" lives). Web domains become 'web:<domain>' keys.

import type { PlistValue } from './bplist';
import type { UsageRow } from './cache';

const COCOA_EPOCH_S = 978307200;

export interface ActivityEntry {
	/** bundle id, or 'web:<domain>' for website usage. */
	key: string;
	seconds: number;
}

export interface DeviceSegment {
	cocoaSeconds: number;
	entries: ActivityEntry[];
}

type Dict = { [key: string]: PlistValue };
const asDict = (v: PlistValue): Dict | null =>
	v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array)
		? (v as Dict)
		: null;

export function extractSegmentActivities(plist: PlistValue): ActivityEntry[] {
	const categories = asDict(asDict(plist)?.value ?? null)?.categoryActivities;
	if (!Array.isArray(categories)) return [];
	const entries: ActivityEntry[] = [];
	for (const category of categories) {
		const c = asDict(category);
		if (!c) continue;
		const webs = Array.isArray(c.webDomainActivities) ? c.webDomainActivities : [];
		for (const web of webs) {
			const w = asDict(web);
			if (w && typeof w.domain === 'string' && typeof w.totalActivityDuration === 'number') {
				entries.push({ key: `web:${w.domain}`, seconds: w.totalActivityDuration });
			}
		}
		const apps = Array.isArray(c.applicationActivities) ? c.applicationActivities : [];
		for (const app of apps) {
			const a = asDict(app);
			if (
				a &&
				typeof a.bundleIdentifier === 'string' &&
				typeof a.totalActivityDuration === 'number'
			) {
				entries.push({ key: a.bundleIdentifier, seconds: a.totalActivityDuration });
			}
		}
	}
	return entries;
}

function dateInTz(tsMs: number, timeZone: string): string {
	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	});
	return fmt.format(tsMs);
}

export function segmentsToRows(
	segmentsByDevice: Record<string, DeviceSegment[]>,
	timeZone: string
): UsageRow[] {
	const rows: UsageRow[] = [];
	for (const [device, segments] of Object.entries(segmentsByDevice)) {
		const sorted = [...segments].sort((a, b) => a.cocoaSeconds - b.cocoaSeconds);
		for (const segment of sorted) {
			const date = dateInTz((segment.cocoaSeconds + COCOA_EPOCH_S) * 1000, timeZone);
			for (const entry of segment.entries) {
				rows.push({
					source: 'screentime',
					device,
					date,
					bundleId: entry.key,
					seconds: Math.round(entry.seconds)
				});
			}
		}
	}
	return rows;
}
