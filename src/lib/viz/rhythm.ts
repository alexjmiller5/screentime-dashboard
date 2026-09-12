import type { FocusSession, HourlyRow } from '../data/cache';
import { makeDateParts } from '../data/intervals';
import { addDays } from './presets';
import { bucketLabel, dateRange, type Bucket, type StackedSeries } from './series';

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

export interface TimelinePoint {
	x: number;
	y: [number, number];
	width: number;
	key: string;
	device: string;
	date: string;
	seconds: number;
	startMs: number;
	endMs: number;
	estimated?: boolean;
}
export interface Timeline {
	dates: string[];
	days: { date: string; x: number; width: number; selected: boolean }[];
	points: TimelinePoint[];
}

/** Equal-width date buckets, with a real calendar slot for every day inside them. */
export function timelineByApp(
	sessions: FocusSession[],
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
			const sliceEnd = Math.min(session.endMs, cursor + 3_600_000 - (msIntoDay % 3_600_000));
			const day = dayMap.get(date);
			if (day?.selected) {
				const seconds = (sliceEnd - cursor) / 1000;
				const y: [number, number] = [msIntoDay / 3_600_000, msIntoDay / 3_600_000 + seconds / 3600];
				if (!perDay.has(date)) perDay.set(date, []);
				perDay.get(date)!.push({
					x: day.x,
					width: day.width,
					y,
					seconds,
					startMs: cursor,
					endMs: sliceEnd,
					estimated: session.estimated,
					key,
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
