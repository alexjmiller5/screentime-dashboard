// Pure selectors: UsageCache rows -> chart-ready series.
// The sources are parallel measurements of the SAME minutes and are never
// summed together - electUsage picks the best one per (device label, day).

import type { UsageRow } from '../data/cache';
import { addDays } from './presets';

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

export type Bucket = 'day' | 'week' | 'month';

/** Bucket label, mirroring notion-task-burndown-chart: weeks anchor on their
 * Monday (a real date), months on 'YYYY-MM'. */
function bucketLabel(date: string, bucket: Bucket): string {
	if (bucket === 'day') return date;
	if (bucket === 'month') return date.slice(0, 7);
	const [y, m, d] = date.split('-').map(Number);
	const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
	return addDays(date, -((weekday + 6) % 7));
}

/** Re-bucket a daily stacked series into week/month buckets holding the
 * AVERAGE seconds per day - edge buckets divide by the days the range
 * actually covers, so partial weeks/months stay honest. 'day' passes
 * through untouched. */
export function bucketize(s: StackedSeries, bucket: Bucket): StackedSeries {
	if (bucket === 'day') return s;
	const labels: string[] = [];
	const indexOf = new Map<string, number>();
	const dayCounts: number[] = [];
	const dateBucket = s.dates.map((d) => {
		const label = bucketLabel(d, bucket);
		let i = indexOf.get(label);
		if (i === undefined) {
			i = labels.length;
			labels.push(label);
			indexOf.set(label, i);
			dayCounts.push(0);
		}
		dayCounts[i]++;
		return i;
	});
	return {
		dates: labels,
		series: s.series.map(({ key, data }) => {
			const sums = labels.map(() => 0);
			data.forEach((v, di) => (sums[dateBucket[di]] += v));
			return { key, data: sums.map((v, i) => v / dayCounts[i]) };
		})
	};
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

/** Daily stacked series per app identity, largest total first - EVERY app is
 * its own series, nothing folds into an "Other". Explicit `pickKeys` act as a
 * filter: only those keys are kept. `keyOf` groups bundles into chart
 * identities (pass appName so the same app recorded under different platform
 * ids - Chrome desktop vs Apple's unified .ios id - becomes ONE series). */
export function dailyByApp(
	rows: UsageRow[],
	keyOf: (bundleId: string) => string = (b) => b,
	pickKeys?: string[]
): StackedSeries {
	const dates = axis(rows);
	if (dates.length === 0) return { dates: [], series: [] };
	const index = new Map(dates.map((d, i) => [d, i]));

	const keys =
		pickKeys !== undefined && pickKeys.length > 0
			? pickKeys
			: topApps(rows, Infinity, keyOf).map((t) => t.bundleId);
	const byKey = new Map(keys.map((k) => [k, dates.map(() => 0)]));
	for (const r of rows) {
		const data = byKey.get(keyOf(r.bundleId));
		if (data) data[index.get(r.date)!] += r.seconds;
	}
	return { dates, series: keys.map((key) => ({ key, data: byKey.get(key)! })) };
}

/** Ranked totals; `bundleId` in the result is the grouped key from `keyOf`,
 * `raw` the group's biggest underlying bundle id (for App Store icon lookup). */
export function topApps(
	rows: UsageRow[],
	n: number,
	keyOf: (bundleId: string) => string = (b) => b
): { bundleId: string; seconds: number; raw: string }[] {
	const groups = new Map<string, Map<string, number>>();
	for (const r of rows) {
		const key = keyOf(r.bundleId);
		let group = groups.get(key);
		if (!group) groups.set(key, (group = new Map()));
		group.set(r.bundleId, (group.get(r.bundleId) ?? 0) + r.seconds);
	}
	return [...groups.entries()]
		.map(([bundleId, byRaw]) => {
			let seconds = 0;
			let raw = bundleId;
			let best = -1;
			for (const [b, s] of byRaw) {
				seconds += s;
				if (s > best) [best, raw] = [s, b];
			}
			return { bundleId, seconds, raw };
		})
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
