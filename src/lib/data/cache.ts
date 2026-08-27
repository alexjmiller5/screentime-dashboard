// The R2 cache document: everything the dashboard needs, already derived.
// Built client-side at import time; the Worker only stores and serves it.

import {
	deriveDailyUsage,
	deriveHourlyUsage,
	aggregateSessions,
	type UsageSession
} from './intervals';
import type { FocusEvent } from './infocus';
import { segmentsToRows, type DeviceSegment } from './deviceactivity';

export interface UsageRow {
	source: 'infocus' | 'knowledgec' | 'screentime';
	device: string;
	date: string;
	bundleId: string;
	seconds: number;
}

export interface HourlyRow {
	device: string;
	date: string;
	/** 0-23, local time. */
	hour: number;
	bundleId: string;
	seconds: number;
}

export interface UsageCache {
	version: 1;
	importedAt: string;
	timeZone: string;
	/** device uuid -> human label, assigned in the UI (never hardcoded). */
	devices: Record<string, string>;
	rows: UsageRow[];
	/** Per-hour focus-derived usage for the day-rhythm grid (>=30s slices). */
	hourly?: HourlyRow[];
}

/** System shell surfaces whose "focus" is not usage: the lock screen holds
 * focus for entire lock periods, springboard/control-center are in-between
 * states. They never become rows. */
const SHELL_BUNDLE_RE =
	/^com\.apple\.(loginwindow|springboard|control-center|coversheet|notificationcenter|usernotificationcenter)/i;

export interface BuildInput {
	timeZone: string;
	importedAt: string;
	devices: Record<string, string>;
	/** All decoded focus events per device uuid, across snapshots (dupes ok). */
	focusEventsByDevice: Record<string, FocusEvent[]>;
	/** All knowledgeC sessions per device, across snapshots (dupes ok). */
	knowledgecSessionsByDevice: Record<string, UsageSession[]>;
	/** DeviceActivity daily segments per device (already deduped by day). */
	deviceActivityByDevice?: Record<string, DeviceSegment[]>;
}

export function buildUsageCache(input: BuildInput): UsageCache {
	const rows: UsageRow[] = [];

	for (const [device, events] of Object.entries(input.focusEventsByDevice)) {
		for (const daily of deriveDailyUsage(events, { timeZone: input.timeZone })) {
			rows.push({ source: 'infocus', device, ...daily });
		}
	}

	for (const [device, sessions] of Object.entries(input.knowledgecSessionsByDevice)) {
		const seen = new Set<string>();
		const unique = sessions.filter((s) => {
			const key = `${s.bundleId}|${s.startMs}|${s.endMs}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		for (const daily of aggregateSessions(unique, input.timeZone)) {
			rows.push({ source: 'knowledgec', device, ...daily });
		}
	}

	rows.push(...segmentsToRows(input.deviceActivityByDevice ?? {}, input.timeZone));

	const hourly: HourlyRow[] = [];
	for (const [device, events] of Object.entries(input.focusEventsByDevice)) {
		for (const h of deriveHourlyUsage(events, { timeZone: input.timeZone })) {
			if (h.seconds >= 30 && !SHELL_BUNDLE_RE.test(h.bundleId)) hourly.push({ device, ...h });
		}
	}

	const usageRows = rows.filter((r) => !SHELL_BUNDLE_RE.test(r.bundleId));
	usageRows.sort(
		(a, b) =>
			a.date.localeCompare(b.date) ||
			a.device.localeCompare(b.device) ||
			a.bundleId.localeCompare(b.bundleId) ||
			a.source.localeCompare(b.source)
	);

	return {
		version: 1,
		importedAt: input.importedAt,
		timeZone: input.timeZone,
		devices: input.devices,
		rows: usageRows,
		hourly
	};
}
