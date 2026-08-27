import { describe, expect, it } from 'vitest';
import {
	filterRows,
	dailyByApp,
	topApps,
	dateRange,
	rollingMean,
	watchlistDaily,
	electUsage,
	combineUsage
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
	it('builds top-N stacked series over a continuous date axis, folding the tail into Other', () => {
		const { dates, series } = dailyByApp(filterRows(rows, { source: 'infocus' }), 2);
		expect(dates).toEqual(['2026-01-01', '2026-01-02']);
		expect(series.map((s) => s.key)).toEqual(['com.a', 'com.b', 'Other']);
		expect(series[0].data).toEqual([100, 200]);
		expect(series[1].data).toEqual([50, 0]);
		expect(series[2].data).toEqual([0, 10]); // com.c folded
	});

	it('returns empty for no rows', () => {
		expect(dailyByApp([], 5)).toEqual({ dates: [], series: [] });
	});

	it('reports each day of top Other constituents so the fold stays inspectable', () => {
		const { series, otherTop } = dailyByApp(
			[
				row('2026-01-01', 'com.a', 100),
				row('2026-01-01', 'com.b', 90),
				row('2026-01-01', 'com.c', 30),
				row('2026-01-01', 'com.d', 20),
				row('2026-01-02', 'com.a', 100)
			],
			2 // com.a + com.b named; c and d fold
		);
		expect(series.map((s) => s.key)).toEqual(['com.a', 'com.b', 'Other']);
		expect(otherTop?.[0]).toEqual([
			{ key: 'com.c', seconds: 30 },
			{ key: 'com.d', seconds: 20 }
		]);
		expect(otherTop?.[1]).toEqual([]);
	});

	it('uses explicitly picked keys as the named series when provided', () => {
		const { series } = dailyByApp(
			[
				row('2026-01-01', 'com.a', 100),
				row('2026-01-01', 'com.b', 90),
				row('2026-01-01', 'com.c', 5)
			],
			8,
			(b) => b,
			['com.c'] // picked despite being smallest
		);
		expect(series.map((s) => s.key)).toEqual(['com.c', 'Other']);
		expect(series[0].data).toEqual([5]);
		expect(series[1].data).toEqual([190]);
	});

	it('merges bundles sharing an app identity when keyed by display name', () => {
		const { series } = dailyByApp(
			[
				row('2026-01-01', 'com.google.Chrome', 100), // Biome desktop id
				row('2026-01-01', 'com.google.chrome.ios', 50) // Screen Time unified id
			],
			5,
			appName
		);
		expect(series).toEqual([{ key: 'Chrome', data: [150] }]);
	});
});

describe('topApps', () => {
	it('ranks bundles by total seconds', () => {
		expect(topApps(filterRows(rows, { source: 'infocus' }), 2)).toEqual([
			{ bundleId: 'com.a', seconds: 300 },
			{ bundleId: 'com.b', seconds: 50 }
		]);
	});
});

describe('rollingMean', () => {
	it('averages over the trailing window', () => {
		expect(rollingMean([2, 4, 6, 8], 2)).toEqual([2, 3, 5, 7]);
	});
});

describe('watchlistDaily', () => {
	it('matches bundles by substring, case-insensitive, over the full axis', () => {
		const result = watchlistDaily(
			[
				row('2026-01-01', 'com.google.ios.youtube', 60),
				row('2026-01-02', 'com.burbn.instagram', 120),
				row('2026-01-02', 'com.a', 999)
			],
			['youtube', 'instagram']
		);
		expect(result.dates).toEqual(['2026-01-01', '2026-01-02']);
		expect(result.series).toEqual([
			{ key: 'youtube', data: [60, 0] },
			{ key: 'instagram', data: [0, 120] }
		]);
	});

	it('matches by display name too, so PWAs count toward their app', () => {
		const result = watchlistDaily(
			[row('2026-01-01', 'com.google.Chrome.app.agimnkijcaahngcdmfeangaknmldooml', 300)],
			['youtube']
		);
		expect(result.series).toEqual([{ key: 'youtube', data: [300] }]);
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
