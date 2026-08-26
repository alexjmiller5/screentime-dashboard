// Pure selectors: UsageCache rows -> chart-ready series.
// Sources are alternative lenses over the same usage and are NEVER summed
// together (knowledgeC and Biome overlap for the Mac) - source is a filter.

import type { UsageRow } from '../data/cache';
import { appName } from './format';

export interface RowFilter {
	source: UsageRow['source'];
	startDate?: string;
	endDate?: string;
	devices?: string[];
}

export function filterRows(rows: UsageRow[], filter: RowFilter): UsageRow[] {
	return rows.filter(
		(r) =>
			r.source === filter.source &&
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

/** Top-N apps as stacked daily series, remaining bundles folded into "Other". */
export function dailyByApp(rows: UsageRow[], topN: number): StackedSeries {
	const dates = axis(rows);
	if (dates.length === 0) return { dates: [], series: [] };
	const index = new Map(dates.map((d, i) => [d, i]));

	const keys = topApps(rows, topN).map((t) => t.bundleId);
	const keySet = new Set(keys);
	const series = [...keys, 'Other'].map((key) => ({ key, data: dates.map(() => 0) }));
	const byKey = new Map(series.map((s) => [s.key, s.data]));
	let hasOther = false;
	for (const r of rows) {
		const key = keySet.has(r.bundleId) ? r.bundleId : 'Other';
		if (key === 'Other') hasOther = true;
		byKey.get(key)![index.get(r.date)!] += r.seconds;
	}
	return { dates, series: hasOther ? series : series.slice(0, -1) };
}

export function topApps(rows: UsageRow[], n: number): { bundleId: string; seconds: number }[] {
	const totals = new Map<string, number>();
	for (const r of rows) totals.set(r.bundleId, (totals.get(r.bundleId) ?? 0) + r.seconds);
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
