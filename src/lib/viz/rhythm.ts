import type { FocusSession, HourlyRow, WebsiteHour } from '../data/cache';
import { makeDateParts, aggregateHourlySessions } from '../data/intervals';
import { addDays } from './presets';
import {
	bucketLabel,
	dateRange,
	combineUsage,
	isBrowser,
	type Bucket,
	type StackedSeries
} from './series';

export const clockHour = (hour: number): string =>
	`${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.floor((hour % 1) * 60 + 1e-6)).padStart(2, '0')}`;

export const sessionTime = (ms: number, timeZone: string): string =>
	new Intl.DateTimeFormat('en-GB', {
		timeZone,
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
		timeZoneName: 'shortOffset'
	}).format(ms);

export function hourlyByApp(
	rows: HourlyRow[],
	keyOf = (key: string) => key,
	picked: string[] = []
): StackedSeries {
	const series = new Map<string, number[]>();
	for (const row of rows) {
		const key = keyOf(row.bundleId);
		if (picked.length && !picked.includes(key)) continue;
		if (!series.has(key)) series.set(key, Array(24).fill(0));
		series.get(key)![row.hour] += row.seconds;
	}
	return {
		dates: Array.from({ length: 24 }, (_, i) => clockHour(i)),
		series: [...series]
			.map(([key, data]) => ({ key, data }))
			.sort(
				(a, b) =>
					b.data.reduce((s, v) => s + v, 0) - a.data.reduce((s, v) => s + v, 0) ||
					a.key.localeCompare(b.key)
			)
	};
}

/** Website durations belong to the recorded hour, never to an invented visit. */
export function combineHourlyUsage(
	focus: HourlyRow[],
	websites: WebsiteHour[],
	timeZone: string,
	labelOf: (device: string) => string,
	originals?: FocusSession[]
): (HourlyRow & { overlapUnknown?: true })[] {
	const parts = makeDateParts(timeZone);
	const webs = websites.map((row) => {
		const { date, msIntoDay } = parts(row.startMs);
		return {
			device: row.device,
			bundleId: row.bundleId,
			seconds: row.seconds,
			date,
			hour: Math.floor(msIntoDay / 3_600_000)
		};
	});
	const groupOf = (r: HourlyRow) => `${labelOf(r.device)}|${r.date}|${r.hour}`;
	if (!originals) return combineUsage(focus, webs, groupOf);
	// With shifted hour grids, totals alone cannot identify temporal overlap.
	const bucket = (timed: TimedUsage[]): HourlyRow[] => {
		const exact = new Map<string, FocusSession[]>();
		const hours: HourlyRow[] = [];
		for (const row of timed) {
			if (row.resolution === 'hour') {
				const { date, msIntoDay } = parts(row.startMs);
				hours.push({
					device: row.device,
					bundleId: row.bundleId,
					date,
					hour: Math.floor(msIntoDay / 3_600_000),
					seconds: row.seconds!
				});
			} else {
				if (!exact.has(row.device)) exact.set(row.device, []);
				exact.get(row.device)!.push(row);
			}
		}
		for (const [device, sessions] of exact)
			hours.push(...aggregateHourlySessions(sessions, timeZone).map((r) => ({ ...r, device })));
		return hours;
	};
	const rawKey = (r: HourlyRow) => `${r.device}|${r.date}|${r.hour}|${r.bundleId}`;
	const fromOriginals = new Map(bucket(originals).map((r) => [rawKey(r), r.seconds]));
	const intersecting = new Set<string>();
	for (const web of websites)
		for (const instant of [web.startMs, web.endMs - 1]) {
			const { date, msIntoDay } = parts(instant);
			intersecting.add(groupOf({ ...web, date, hour: Math.floor(msIntoDay / 3_600_000) }));
		}
	const retained = focus.flatMap((r) => {
		const seconds = Math.max(0, r.seconds - (fromOriginals.get(rawKey(r)) ?? 0));
		return seconds > 0
			? [
					{
						...r,
						seconds,
						...(isBrowser(r.bundleId) && intersecting.has(groupOf(r))
							? { overlapUnknown: true as const }
							: {})
					}
				]
			: [];
	});
	return [...bucket(withWebsiteHours(originals, websites, labelOf)), ...retained];
}

export interface TimedUsage extends FocusSession {
	/** A total within the whole recorded hour; not an exact session interval. */
	resolution?: 'hour';
	seconds?: number;
}

/** Replace browser portions covered by website measurements with hour totals.
 * We cannot know where the browser's remaining minutes occurred within that hour. */
export function withWebsiteHours(
	sessions: FocusSession[],
	websites: WebsiteHour[],
	labelOf: (device: string) => string
): TimedUsage[] {
	const out: TimedUsage[] = [];
	const windows = new Map<
		string,
		{ startMs: number; endMs: number; seconds: number; browsers: Map<string, TimedUsage> }[]
	>();
	const grouped = new Map<string, WebsiteHour[]>();
	for (const web of websites) {
		const key = `${labelOf(web.device)}|${web.startMs}|${web.endMs}`;
		if (!grouped.has(key)) grouped.set(key, []);
		grouped.get(key)!.push(web);
		out.push({ ...web, resolution: 'hour' });
	}
	for (const group of grouped.values()) {
		const first = group[0],
			label = labelOf(first.device);
		if (!windows.has(label)) windows.set(label, []);
		windows.get(label)!.push({
			startMs: first.startMs,
			endMs: first.endMs,
			seconds: group.reduce((s, w) => s + w.seconds, 0),
			browsers: new Map()
		});
	}
	for (const group of windows.values()) group.sort((a, b) => a.startMs - b.startMs);
	for (const session of sessions) {
		const group = windows.get(labelOf(session.device));
		if (!isBrowser(session.bundleId) || !group) {
			out.push(session);
			continue;
		}
		let cursor = session.startMs;
		// Find the first recorded hour that can overlap this session.
		let lo = 0,
			hi = group.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (group[mid].endMs <= cursor) lo = mid + 1;
			else hi = mid;
		}
		for (let i = lo; i < group.length && group[i].startMs < session.endMs; i++) {
			const window = group[i];
			if (cursor < window.startMs) out.push({ ...session, startMs: cursor, endMs: window.startMs });
			const endMs = Math.min(session.endMs, window.endMs);
			const seconds = (endMs - Math.max(cursor, window.startMs)) / 1000;
			if (seconds > 0) {
				const key = `${session.device}|${session.bundleId}`;
				const previous = window.browsers.get(key);
				if (previous) previous.seconds! += seconds;
				else
					window.browsers.set(key, {
						...session,
						startMs: window.startMs,
						endMs: window.endMs,
						seconds,
						resolution: 'hour'
					});
			}
			cursor = Math.max(cursor, endMs);
		}
		if (cursor < session.endMs) out.push({ ...session, startMs: cursor });
	}
	for (const group of windows.values())
		for (const window of group) {
			const total = [...window.browsers.values()].reduce((s, b) => s + b.seconds!, 0);
			const scale = total > 0 ? Math.max(0, total - window.seconds) / total : 0;
			for (const browser of window.browsers.values()) {
				const seconds = Math.round(browser.seconds! * scale);
				if (seconds > 0) out.push({ ...browser, seconds });
			}
		}
	return out;
}

export interface TimelinePoint {
	x: number;
	y: [number, number];
	width: number;
	key: string;
	bundleId: string;
	device: string;
	date: string;
	seconds: number;
	startMs: number;
	endMs: number;
	estimated?: boolean;
	resolution?: 'hour';
}
export interface Timeline {
	dates: string[];
	days: { date: string; x: number; width: number; selected: boolean }[];
	points: TimelinePoint[];
}

/** Equal-width date buckets, with a real calendar slot for every day inside them. */
export function timelineByApp(
	sessions: TimedUsage[],
	timeZone: string,
	start: string,
	end: string,
	bucket: Bucket,
	keyOf = (key: string) => key,
	picked: string[] = []
): Timeline {
	const dates = [...new Set(dateRange(start, end).map((d) => bucketLabel(d, bucket)))];
	const days = dates.flatMap((label, i) => {
		const first = bucket === 'month' ? `${label}-01` : label;
		const count =
			bucket === 'week'
				? 7
				: bucket === 'month'
					? new Date(Date.UTC(Number(label.slice(0, 4)), Number(label.slice(5, 7)), 0)).getUTCDate()
					: 1;
		return Array.from({ length: count }, (_, d) => {
			const date = addDays(first, d);
			return { date, x: i + d / count, width: 1 / count, selected: date >= start && date <= end };
		});
	});
	const dayMap = new Map(days.map((d) => [d.date, d]));
	const parts = makeDateParts(timeZone);
	const perDay = new Map<string, TimelinePoint[]>();
	for (const session of sessions) {
		const key = keyOf(session.bundleId);
		if (picked.length && !picked.includes(key)) continue;
		let cursor = session.startMs;
		while (cursor < session.endMs) {
			const { date, msIntoDay } = parts(cursor);
			const sliceEnd =
				session.resolution === 'hour'
					? session.endMs
					: Math.min(session.endMs, cursor + 3_600_000 - (msIntoDay % 3_600_000));
			const day = dayMap.get(date);
			if (day?.selected) {
				const seconds =
					session.resolution === 'hour' ? session.seconds! : (sliceEnd - cursor) / 1000;
				const y: [number, number] =
					session.resolution === 'hour'
						? [Math.floor(msIntoDay / 3_600_000), Math.floor(msIntoDay / 3_600_000) + 1]
						: [msIntoDay / 3_600_000, msIntoDay / 3_600_000 + seconds / 3600];
				if (!perDay.has(date)) perDay.set(date, []);
				perDay.get(date)!.push({
					x: day.x,
					width: day.width,
					y,
					seconds,
					startMs: cursor,
					endMs: sliceEnd,
					estimated: session.estimated,
					resolution: session.resolution,
					key,
					bundleId: session.bundleId,
					device: session.device,
					date
				});
			}
			cursor = sliceEnd;
		}
	}
	const points: TimelinePoint[] = [];
	for (const day of perDay.values()) {
		day.sort(
			(a, b) => a.y[0] - b.y[0] || a.device.localeCompare(b.device) || a.key.localeCompare(b.key)
		);
		const ends: number[] = [];
		const lanes = day.map((point) => {
			let lane = ends.findIndex((end) => end <= point.y[0]);
			if (lane < 0) lane = ends.length;
			ends[lane] = point.y[1];
			return lane;
		});
		day.forEach((point, i) =>
			points.push({
				...point,
				width: point.width / ends.length,
				x: point.x + ((lanes[i] + 0.5) * point.width) / ends.length
			})
		);
	}
	return { dates, days, points };
}
