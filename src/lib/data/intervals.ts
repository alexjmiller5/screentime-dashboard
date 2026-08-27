// Focus events -> per-bundle daily usage seconds.
// Sessions are explicit in the stream (focus gained/lost pairs), so duration
// is exact - no gap heuristics. The cap only guards against lost unfocus
// events (device died mid-session, stream truncation).

import type { FocusEvent } from './infocus';

export interface DailyUsage {
	/** YYYY-MM-DD in the aggregation time zone. */
	date: string;
	bundleId: string;
	seconds: number;
}

export interface DeriveOptions {
	timeZone: string;
	/** Sessions longer than this are truncated. Default 4h. */
	maxSessionMs?: number;
}

const DAY_MS = 86_400_000;

function makeDateParts(timeZone: string) {
	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23'
	});
	return (tsMs: number): { date: string; msIntoDay: number } => {
		const p: Record<string, string> = {};
		for (const part of fmt.formatToParts(tsMs)) p[part.type] = part.value;
		return {
			date: `${p.year}-${p.month}-${p.day}`,
			msIntoDay:
				(Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000 + (tsMs % 1000)
		};
	};
}

/** Dedup + pair focus/unfocus events into sessions. */
export function sessionsFromEvents(events: FocusEvent[], maxSessionMs: number): UsageSession[] {
	const seen = new Set<string>();
	const sorted = events
		.filter((e) => {
			const key = `${e.tsMs}|${e.bundleId}|${e.focus}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => a.tsMs - b.tsMs);

	const open = new Map<string, number>();
	const sessions: UsageSession[] = [];
	const close = (bundleId: string, endMs: number) => {
		const startMs = open.get(bundleId);
		if (startMs === undefined || endMs <= startMs) return;
		sessions.push({ bundleId, startMs, endMs: Math.min(endMs, startMs + maxSessionMs) });
		open.delete(bundleId);
	};
	for (const e of sorted) {
		if (e.focus) {
			close(e.bundleId, e.tsMs); // refocus without unfocus: previous session ran until now
			open.set(e.bundleId, e.tsMs);
		} else {
			close(e.bundleId, e.tsMs);
		}
	}
	return sessions;
}

export function deriveDailyUsage(events: FocusEvent[], options: DeriveOptions): DailyUsage[] {
	const maxSessionMs = options.maxSessionMs ?? 4 * 60 * 60 * 1000;
	return aggregateSessions(sessionsFromEvents(events, maxSessionMs), options.timeZone);
}

export interface HourlyUsage {
	date: string;
	hour: number;
	bundleId: string;
	seconds: number;
}

/** Sessions sliced into per-hour buckets (local time) - feeds the day grid. */
export function deriveHourlyUsage(events: FocusEvent[], options: DeriveOptions): HourlyUsage[] {
	const maxSessionMs = options.maxSessionMs ?? 4 * 60 * 60 * 1000;
	const parts = makeDateParts(options.timeZone);
	const HOUR_MS = 3_600_000;

	const totals = new Map<string, number>();
	for (const { bundleId, startMs, endMs } of sessionsFromEvents(events, maxSessionMs)) {
		let cursor = startMs;
		while (cursor < endMs) {
			const { date, msIntoDay } = parts(cursor);
			const hour = Math.floor(msIntoDay / HOUR_MS);
			const hourEnd = cursor + (HOUR_MS - (msIntoDay % HOUR_MS));
			const sliceEnd = Math.min(endMs, hourEnd);
			const key = `${date}|${hour}|${bundleId}`;
			totals.set(key, (totals.get(key) ?? 0) + (sliceEnd - cursor));
			cursor = sliceEnd;
		}
	}

	return [...totals.entries()]
		.map(([key, ms]) => {
			const [date, hour, bundleId] = key.split('|');
			return { date, hour: Number(hour), bundleId, seconds: Math.round(ms / 1000) };
		})
		.sort(
			(a, b) =>
				a.date.localeCompare(b.date) || a.hour - b.hour || a.bundleId.localeCompare(b.bundleId)
		);
}

export interface UsageSession {
	bundleId: string;
	startMs: number;
	endMs: number;
}

/** Absolute sessions -> per-bundle daily seconds, split at local midnight. */
export function aggregateSessions(sessions: UsageSession[], timeZone: string): DailyUsage[] {
	const parts = makeDateParts(timeZone);
	// ponytail: the midnight boundary is derived from local h:m:s, which is off
	// by an hour for sessions spanning the two DST switch midnights a year -
	// switch to a tz lib if that ever matters.
	const totals = new Map<string, number>();
	for (const { bundleId, startMs, endMs } of sessions) {
		let cursor = startMs;
		while (cursor < endMs) {
			const { date, msIntoDay } = parts(cursor);
			const dayEnd = cursor + (DAY_MS - msIntoDay);
			const sliceEnd = Math.min(endMs, dayEnd);
			const key = `${date}|${bundleId}`;
			totals.set(key, (totals.get(key) ?? 0) + (sliceEnd - cursor));
			cursor = sliceEnd;
		}
	}

	return [...totals.entries()]
		.map(([key, ms]) => {
			const [date, bundleId] = key.split('|');
			return { date, bundleId, seconds: Math.round(ms / 1000) };
		})
		.sort((a, b) => a.date.localeCompare(b.date) || a.bundleId.localeCompare(b.bundleId));
}
