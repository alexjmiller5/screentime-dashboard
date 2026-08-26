// Pure selectors: UsageCache rows -> chart-ready series.
// The sources are parallel measurements of the SAME minutes and are never
// summed together - electUsage picks the best one per (device label, day).

import type { UsageRow } from '../data/cache';
import { appName } from './format';

export interface RowFilter {
	source?: UsageRow['source'];
	startDate?: string;
	endDate?: string;
	devices?: string[];
}

export function filterRows(rows: UsageRow[], filter: RowFilter): UsageRow[] {
	return rows.filter(
		(r) =>
			(!filter.source || r.source === filter.source) &&
			(!filter.startDate || r.date >= filter.startDate) &&
			(!filter.endDate || r.date <= filter.endDate) &&
			(!filter.devices || filter.devices.includes(r.device))
	);
}

/** Every YYYY-MM-DD from start to end inclusive (UTC arithmetic - dates are labels). */
export function dateRange(start: string, end: string): string[] {
	const dates: string[] = [];
	for (let t = Date.parse(start); t <= Date.parse(end); t += 86_400_000) {
		dates.push(new Date(t).toISOString().slice(0, 10));
	}
	return dates;
}

export interface StackedSeries {
	dates: string[];
	series: { key: string; data: number[] }[];
}

function axis(rows: UsageRow[]): string[] {
	if (rows.length === 0) return [];
	let min = rows[0].date;
	let max = rows[0].date;
	for (const r of rows) {
		if (r.date < min) min = r.date;
		if (r.date > max) max = r.date;
	}
	return dateRange(min, max);
}

/** Top-N apps as stacked daily series, remaining bundles folded into "Other".
 * `keyOf` groups bundles into chart identities (pass appName so the same app
 * recorded under different platform ids - Chrome desktop vs Apple's unified
 * .ios id - becomes ONE series). */
export function dailyByApp(
	rows: UsageRow[],
	topN: number,
	keyOf: (bundleId: string) => string = (b) => b
): StackedSeries {
	const dates = axis(rows);
	if (dates.length === 0) return { dates: [], series: [] };
	const index = new Map(dates.map((d, i) => [d, i]));

	const keys = topApps(rows, topN, keyOf).map((t) => t.bundleId);
	const keySet = new Set(keys);
	const series = [...keys, 'Other'].map((key) => ({ key, data: dates.map(() => 0) }));
	const byKey = new Map(series.map((s) => [s.key, s.data]));
	let hasOther = false;
	for (const r of rows) {
		const mapped = keyOf(r.bundleId);
		const key = keySet.has(mapped) ? mapped : 'Other';
		if (key === 'Other') hasOther = true;
		byKey.get(key)![index.get(r.date)!] += r.seconds;
	}
	return { dates, series: hasOther ? series : series.slice(0, -1) };
}

/** Ranked totals; `bundleId` in the result is the grouped key from `keyOf`. */
export function topApps(
	rows: UsageRow[],
	n: number,
	keyOf: (bundleId: string) => string = (b) => b
): { bundleId: string; seconds: number }[] {
	const totals = new Map<string, number>();
	for (const r of rows) {
		const key = keyOf(r.bundleId);
		totals.set(key, (totals.get(key) ?? 0) + r.seconds);
	}
	return [...totals.entries()]
		.map(([bundleId, seconds]) => ({ bundleId, seconds }))
		.sort((a, b) => b.seconds - a.seconds || a.bundleId.localeCompare(b.bundleId))
		.slice(0, n);
}

/** Trailing mean over up to `window` values (partial windows at the start). */
export function rollingMean(values: number[], window: number): number[] {
	const out: number[] = [];
	let sum = 0;
	for (let i = 0; i < values.length; i++) {
		sum += values[i];
		if (i >= window) sum -= values[i - window];
		out.push(sum / Math.min(i + 1, window));
	}
	return out;
}

const SOURCE_RANK: Record<UsageRow['source'], number> = {
	screentime: 0, // Apple's official aggregates - matches the Settings pane
	infocus: 1, // our focus-session derivation - fills Screen Time's gaps
	knowledgec: 2 // legacy Mac store - last resort
};

/**
 * Collapse the parallel measurement pipelines into one series: per (device
 * LABEL, date) keep only the best-ranked source that has data. Labels are the
 * cross-pipeline device identity (the same iPhone has different uuids in
 * Biome and DeviceActivity - naming both "iPhone" merges them). Website rows
 * (web:*) only exist in Screen Time and are returned separately so they never
 * compete with - or double-count against - app rows.
 */
export function electUsage(
	rows: UsageRow[],
	labelOf: (device: string) => string
): { apps: UsageRow[]; webs: UsageRow[] } {
	const webs = rows.filter((r) => r.bundleId.startsWith('web:'));
	const appRows = rows.filter((r) => !r.bundleId.startsWith('web:'));

	const best = new Map<string, number>();
	for (const r of appRows) {
		const key = `${labelOf(r.device)}|${r.date}`;
		const rank = SOURCE_RANK[r.source];
		if (rank < (best.get(key) ?? Infinity)) best.set(key, rank);
	}
	return {
		apps: appRows.filter(
			(r) => SOURCE_RANK[r.source] === best.get(`${labelOf(r.device)}|${r.date}`)
		),
		webs
	};
}

/** True when a bundle counts toward a watchlist term: matches the bundle id
 * OR the display name, so PWAs ("YouTube (PWA)") count toward their app. */
export function matchesTerm(bundleId: string, term: string): boolean {
	const t = term.toLowerCase();
	return bundleId.toLowerCase().includes(t) || appName(bundleId).toLowerCase().includes(t);
}

/** Daily seconds per watchlist term (case-insensitive). */
export function watchlistDaily(rows: UsageRow[], terms: string[]): StackedSeries {
	const dates = axis(rows);
	const index = new Map(dates.map((d, i) => [d, i]));
	const series = terms.map((key) => ({ key, data: dates.map(() => 0) }));
	for (const r of rows) {
		for (const s of series) {
			if (matchesTerm(r.bundleId, s.key)) s.data[index.get(r.date)!] += r.seconds;
		}
	}
	return { dates, series };
}
