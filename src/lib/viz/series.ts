// Pure selectors: UsageCache rows -> chart-ready series.
// The sources are parallel measurements of the SAME minutes and are never
// summed together - electUsage picks the best one per (device label, day).

import type { UsageRow, HourlyRow } from '../data/cache';

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
	/** Per date (aligned with `dates`): the largest constituents folded into
	 * "Other" that day, so the gray segment stays inspectable. */
	otherTop?: { key: string; seconds: number }[][];
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
	keyOf: (bundleId: string) => string = (b) => b,
	pickKeys?: string[]
): StackedSeries {
	const dates = axis(rows);
	if (dates.length === 0) return { dates: [], series: [] };
	const index = new Map(dates.map((d, i) => [d, i]));

	const keys =
		pickKeys && pickKeys.length > 0 ? pickKeys : topApps(rows, topN, keyOf).map((t) => t.bundleId);
	const keySet = new Set(keys);
	const series = [...keys, 'Other'].map((key) => ({ key, data: dates.map(() => 0) }));
	const byKey = new Map(series.map((s) => [s.key, s.data]));
	const otherByDay: Map<string, number>[] = dates.map(() => new Map());
	let hasOther = false;
	for (const r of rows) {
		const mapped = keyOf(r.bundleId);
		const day = index.get(r.date)!;
		if (keySet.has(mapped)) {
			byKey.get(mapped)![day] += r.seconds;
		} else {
			hasOther = true;
			byKey.get('Other')![day] += r.seconds;
			otherByDay[day].set(mapped, (otherByDay[day].get(mapped) ?? 0) + r.seconds);
		}
	}
	const otherTop = otherByDay.map((m) =>
		[...m.entries()]
			.map(([key, seconds]) => ({ key, seconds }))
			.sort((a, b) => b.seconds - a.seconds)
			.slice(0, 5)
	);
	return { dates, series: hasOther ? series : series.slice(0, -1), otherTop };
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

const BROWSERS = new Set([
	'com.google.chrome',
	'com.google.chrome.ios',
	'com.apple.safari',
	'com.apple.mobilesafari',
	'org.mozilla.firefox'
]);

/**
 * One honest combined stack of apps AND websites: website time happens
 * INSIDE browsers, so per (device, day) browsers are scaled down to just the
 * residual not attributed to tracked domains, and the domains stand as
 * first-class series. Non-browser apps pass through. (Domains reported by
 * WKWebView apps - not browsers - can still slightly double-count their host
 * app; small and accepted.)
 */
export function combineUsage(apps: UsageRow[], webs: UsageRow[]): UsageRow[] {
	const webTotal = new Map<string, number>();
	for (const r of webs) {
		const key = `${r.device}|${r.date}`;
		webTotal.set(key, (webTotal.get(key) ?? 0) + r.seconds);
	}
	const browserTotal = new Map<string, number>();
	for (const r of apps) {
		if (!BROWSERS.has(r.bundleId.toLowerCase())) continue;
		const key = `${r.device}|${r.date}`;
		browserTotal.set(key, (browserTotal.get(key) ?? 0) + r.seconds);
	}

	const out: UsageRow[] = [];
	for (const r of apps) {
		if (!BROWSERS.has(r.bundleId.toLowerCase())) {
			out.push(r);
			continue;
		}
		const key = `${r.device}|${r.date}`;
		const total = browserTotal.get(key)!;
		const covered = Math.min(webTotal.get(key) ?? 0, total);
		const residual = Math.round(r.seconds * ((total - covered) / total));
		if (residual > 0) out.push({ ...r, seconds: residual });
	}
	return [...out, ...webs];
}

export interface DayGridCell {
	/** Dominant app identity for the hour. */
	key: string;
	/** Total usage seconds in the hour, all apps. */
	seconds: number;
	/** Largest constituents, for the tooltip. */
	top: { key: string; seconds: number }[];
}

/** [dateIndex][hour 0-23] matrix for the day-rhythm grid; null = no usage. */
export function dayGridCells(
	hourly: HourlyRow[],
	dates: string[],
	keyOf: (bundleId: string) => string
): (DayGridCell | null)[][] {
	const dateIndex = new Map(dates.map((d, i) => [d, i]));
	const buckets: (Map<string, number> | null)[][] = dates.map(() =>
		Array.from({ length: 24 }, () => null)
	);
	for (const r of hourly) {
		const di = dateIndex.get(r.date);
		if (di === undefined) continue;
		const bucket = (buckets[di][r.hour] ??= new Map());
		const key = keyOf(r.bundleId);
		bucket.set(key, (bucket.get(key) ?? 0) + r.seconds);
	}
	return buckets.map((day) =>
		day.map((bucket) => {
			if (!bucket) return null;
			const top = [...bucket.entries()]
				.map(([key, seconds]) => ({ key, seconds }))
				.sort((a, b) => b.seconds - a.seconds)
				.slice(0, 3);
			return {
				key: top[0].key,
				seconds: [...bucket.values()].reduce((a, b) => a + b, 0),
				top
			};
		})
	);
}
