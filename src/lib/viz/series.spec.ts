import { describe, expect, it } from 'vitest';
import {
	filterRows,
	dailyByApp,
	topApps,
	dateRange,
	electUsage,
	combineUsage,
	bucketize
} from './series';
import type { UsageRow } from '../data/cache';
import { appName } from './format';

const row = (
	date: string,
	bundleId: string,
	seconds: number,
	device = 'phone',
	source: UsageRow['source'] = 'infocus'
): UsageRow => ({ source, device, date, bundleId, seconds });

const rows: UsageRow[] = [
	row('2026-01-01', 'com.a', 100),
	row('2026-01-01', 'com.b', 50),
	row('2026-01-02', 'com.a', 200),
	row('2026-01-02', 'com.c', 10, 'mac'),
	row('2026-01-03', 'com.mac', 400, 'knowledgec', 'knowledgec')
];

describe('filterRows', () => {
	it('filters by source, date range, and devices', () => {
		expect(filterRows(rows, { source: 'infocus' })).toHaveLength(4);
		expect(filterRows(rows, { source: 'knowledgec' })).toHaveLength(1);
		expect(
			filterRows(rows, { source: 'infocus', startDate: '2026-01-02', endDate: '2026-01-02' })
		).toHaveLength(2);
		expect(filterRows(rows, { source: 'infocus', devices: ['mac'] })).toEqual([
			row('2026-01-02', 'com.c', 10, 'mac')
		]);
	});
});

describe('dateRange', () => {
	it('fills every day between min and max', () => {
		expect(dateRange('2026-01-30', '2026-02-02')).toEqual([
			'2026-01-30',
			'2026-01-31',
			'2026-02-01',
			'2026-02-02'
		]);
	});
});

describe('dailyByApp', () => {
	it('gives EVERY app its own series, largest total first - no Other fold', () => {
		const { dates, series } = dailyByApp(filterRows(rows, { source: 'infocus' }));
		expect(dates).toEqual(['2026-01-01', '2026-01-02']);
		expect(series.map((s) => s.key)).toEqual(['com.a', 'com.b', 'com.c']);
		expect(series[0].data).toEqual([100, 200]);
		expect(series[1].data).toEqual([50, 0]);
		expect(series[2].data).toEqual([0, 10]);
	});

	it('returns empty for no rows', () => {
		expect(dailyByApp([])).toEqual({ dates: [], series: [] });
	});

	it('shows ONLY explicitly picked keys when picks are active', () => {
		const { series } = dailyByApp(
			[
				row('2026-01-01', 'com.a', 100),
				row('2026-01-01', 'com.b', 90),
				row('2026-01-01', 'com.c', 5)
			],
			(b) => b,
			['com.c'] // picked despite being smallest
		);
		expect(series.map((s) => s.key)).toEqual(['com.c']);
		expect(series[0].data).toEqual([5]);
	});

	it('merges bundles sharing an app identity when keyed by display name', () => {
		const { series } = dailyByApp(
			[
				row('2026-01-01', 'com.google.Chrome', 100), // Biome desktop id
				row('2026-01-01', 'com.google.chrome.ios', 50) // Screen Time unified id
			],
			appName
		);
		expect(series).toEqual([{ key: 'Chrome', data: [150] }]);
	});
});

describe('topApps', () => {
	it('ranks bundles by total seconds', () => {
		expect(topApps(filterRows(rows, { source: 'infocus' }), 2)).toEqual([
			{ bundleId: 'com.a', seconds: 300, raw: 'com.a' },
			{ bundleId: 'com.b', seconds: 50, raw: 'com.b' }
		]);
	});

	it('carries the biggest raw bundle id of each grouped identity', () => {
		expect(
			topApps(
				[
					row('2026-01-01', 'com.google.Chrome', 100),
					row('2026-01-01', 'com.google.chrome.ios', 150)
				],
				5,
				appName
			)
		).toEqual([{ bundleId: 'Chrome', seconds: 250, raw: 'com.google.chrome.ios' }]);
	});
});

describe('combineUsage', () => {
	it('replaces browser time with its domains, keeping only the residual', () => {
		const apps = [
			row('2026-01-05', 'com.mitchellh.ghostty', 200),
			row('2026-01-05', 'com.google.chrome.ios', 100)
		];
		const webs = [row('2026-01-05', 'web:movies.test', 80)];
		expect(combineUsage(apps, webs)).toEqual([
			row('2026-01-05', 'com.mitchellh.ghostty', 200),
			row('2026-01-05', 'com.google.chrome.ios', 20), // 100 - 80 attributed to domains
			row('2026-01-05', 'web:movies.test', 80)
		]);
	});

	it('drops the browser entirely when domains cover it', () => {
		const apps = [row('2026-01-05', 'com.google.chrome.ios', 50)];
		const webs = [row('2026-01-05', 'web:movies.test', 70)];
		expect(combineUsage(apps, webs)).toEqual([row('2026-01-05', 'web:movies.test', 70)]);
	});

	it('passes apps through when a day has no web data (Screen Time gaps)', () => {
		const apps = [row('2026-01-06', 'com.google.chrome.ios', 100)];
		expect(combineUsage(apps, [])).toEqual(apps);
	});
});

describe('electUsage', () => {
	const labelOf = (d: string): string => (d === 'biome-1' || d === 'da-1' ? 'iPhone' : d);

	it('prefers Screen Time aggregates per (device label, date), falls back to focus events', () => {
		const rows = [
			row('2026-01-05', 'com.a', 100, 'biome-1', 'infocus'),
			row('2026-01-05', 'com.a', 120, 'da-1', 'screentime'), // same phone, same day
			row('2026-01-06', 'com.a', 50, 'biome-1', 'infocus') // Screen Time gap day
		];
		const { apps } = electUsage(rows, labelOf);
		expect(apps).toEqual([
			row('2026-01-05', 'com.a', 120, 'da-1', 'screentime'),
			row('2026-01-06', 'com.a', 50, 'biome-1', 'infocus')
		]);
	});

	it('falls back to knowledgec when it is the only measurement', () => {
		const rows = [row('2026-01-05', 'com.mac', 400, 'knowledgec', 'knowledgec')];
		expect(electUsage(rows, (d) => d).apps).toEqual(rows);
	});

	it('separates website rows - they never compete with app rows', () => {
		const rows = [
			row('2026-01-05', 'web:youtube.com', 60, 'da-1', 'screentime'),
			row('2026-01-05', 'com.a', 100, 'biome-1', 'infocus')
		];
		const result = electUsage(rows, labelOf);
		expect(result.webs).toEqual([row('2026-01-05', 'web:youtube.com', 60, 'da-1', 'screentime')]);
		expect(result.apps).toEqual([row('2026-01-05', 'com.a', 100, 'biome-1', 'infocus')]);
	});
});

describe('bucketize', () => {
	const daily = {
		// Thu 2026-01-01 .. Wed 2026-01-07 spans two Monday-anchored weeks
		dates: dateRange('2026-01-01', '2026-01-07'),
		series: [{ key: 'com.a', data: [7000, 0, 0, 0, 3000, 3000, 3000] }]
	};

	it('day passes through unchanged', () => {
		expect(bucketize(daily, 'day')).toBe(daily);
	});

	it('week buckets to Monday labels holding the week TOTAL', () => {
		const { dates, series } = bucketize(daily, 'week');
		// Jan 1-4 belong to the week of Mon Dec 29; Jan 5-7 to Mon Jan 5
		expect(dates).toEqual(['2025-12-29', '2026-01-05']);
		expect(series[0].data).toEqual([7000, 9000]);
	});

	it('month buckets to YYYY-MM holding the month TOTAL', () => {
		const twoMonths = {
			dates: dateRange('2026-01-30', '2026-02-02'),
			series: [{ key: 'com.a', data: [100, 300, 500, 700] }]
		};
		const { dates, series } = bucketize(twoMonths, 'month');
		expect(dates).toEqual(['2026-01', '2026-02']);
		expect(series[0].data).toEqual([400, 1200]);
	});
});
