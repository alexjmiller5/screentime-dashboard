import { expect, it } from 'vitest';
import {
	hourlyByApp,
	timelineByApp,
	sessionTime,
	combineHourlyUsage,
	withWebsiteHours
} from './rhythm';

const session = (start: string, end: string, bundleId = 'app', device = 'phone') => ({
	startMs: Date.parse(start),
	endMs: Date.parse(end),
	bundleId,
	device
});

it('keeps 24 hourly totals, merges app identities, and honors app picks', () => {
	const rows = [
		{ date: '2026-02-01', device: 'phone', hour: 9, bundleId: 'app.ios', seconds: 600 },
		{ date: '2026-02-02', device: 'phone', hour: 9, bundleId: 'app.mac', seconds: 1200 },
		{ date: '2026-02-02', device: 'phone', hour: 23, bundleId: 'other', seconds: 300 }
	];
	const result = hourlyByApp(rows, (key) => key.split('.')[0], ['app']);
	expect(result.dates).toEqual(
		Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`)
	);
	expect(result.series).toEqual([
		{
			key: 'app',
			data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1800, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
		}
	]);
	expect(hourlyByApp([]).dates).toHaveLength(24);
});

it('positions actual sessions at local clock times and clips at the selected midnight', () => {
	const result = timelineByApp(
		[
			session('2026-02-02T04:45:00Z', '2026-02-02T05:15:00Z'),
			session('2026-02-02T06:00:00Z', '2026-02-02T06:30:00Z', 'excluded')
		],
		'America/New_York',
		'2026-02-02',
		'2026-02-02',
		'day',
		(key) => key,
		['app']
	);
	expect(result.dates).toEqual(['2026-02-02']);
	expect(result.points).toHaveLength(1);
	expect(result.points[0]).toMatchObject({
		date: '2026-02-02',
		key: 'app',
		x: 0.5,
		width: 1,
		y: [0, 0.25],
		seconds: 900
	});
});

it('subdivides whole weeks and calendar months, preserving blank days outside a partial range', () => {
	const input = [session('2024-02-29T09:00:00Z', '2024-02-29T09:30:00Z')];
	const week = timelineByApp(input, 'UTC', '2024-02-29', '2024-03-01', 'week');
	expect(week.dates).toEqual(['2024-02-26']);
	expect(week.days).toHaveLength(7);
	expect(week.points[0]).toMatchObject({ x: 3.5 / 7, width: 1 / 7 });
	const month = timelineByApp(input, 'UTC', '2024-02-29', '2024-03-01', 'month');
	expect(month.dates).toEqual(['2024-02', '2024-03']);
	expect(month.days).toHaveLength(60);
	expect(month.points[0].x).toBeCloseTo(28.5 / 29);
	expect(month.points[0].width).toBeCloseTo(1 / 29);
});

it('keeps simultaneous device sessions visible in separate lanes', () => {
	const result = timelineByApp(
		[
			session('2026-02-01T09:00:00Z', '2026-02-01T10:00:00Z'),
			session('2026-02-01T09:00:00Z', '2026-02-01T10:00:00Z', 'other', 'laptop')
		],
		'UTC',
		'2026-02-01',
		'2026-02-01',
		'day'
	);
	expect(result.points.map((p) => [p.x, p.width])).toEqual([
		[0.25, 0.5],
		[0.75, 0.5]
	]);
});

it('preserves real duration through DST jumps and repeated clock hours', () => {
	const spring = timelineByApp(
		[session('2026-03-08T06:30:00Z', '2026-03-08T07:30:00Z')],
		'America/New_York',
		'2026-03-08',
		'2026-03-08',
		'day'
	);
	expect(spring.points.map((p) => p.y)).toEqual([
		[1.5, 2],
		[3, 3.5]
	]);
	expect(spring.points.reduce((sum, p) => sum + p.seconds, 0)).toBe(3600);
	expect(sessionTime(spring.points[0].endMs, 'America/New_York')).toBe('03:00:00 GMT-4');
	const fall = timelineByApp(
		[session('2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z')],
		'America/New_York',
		'2026-11-01',
		'2026-11-01',
		'day'
	);
	expect(fall.points.map((p) => p.y)).toEqual([
		[1, 1.5],
		[1.5, 2]
	]);
	expect(fall.points.reduce((sum, p) => sum + p.seconds, 0)).toBe(3600);
	expect(sessionTime(fall.points[1].startMs, 'America/New_York')).toBe('01:30:00 GMT-4');
	expect(sessionTime(fall.points[1].endMs, 'America/New_York')).toBe('01:00:00 GMT-5');
});

it('adds recorded website hours without counting their browser time twice across device ids', () => {
	const websites = [
		{
			...session(
				'2026-02-01T14:00:00Z',
				'2026-02-01T15:00:00Z',
				'web:video.example',
				'screen-phone'
			),
			seconds: 1200
		},
		{
			...session(
				'2026-02-01T14:00:00Z',
				'2026-02-01T15:00:00Z',
				'web:short.example',
				'screen-phone'
			),
			seconds: 8
		}
	];
	const label = (id: string) => (id.endsWith('phone') ? 'Phone' : id);
	const hours = combineHourlyUsage(
		[
			{
				device: 'focus-phone',
				date: '2026-02-01',
				hour: 9,
				bundleId: 'com.apple.mobilesafari',
				seconds: 1800
			},
			{
				device: 'focus-phone',
				date: '2026-02-01',
				hour: 10,
				bundleId: 'com.apple.mobilesafari',
				seconds: 900
			},
			{ device: 'laptop', date: '2026-02-01', hour: 9, bundleId: 'com.apple.safari', seconds: 600 }
		],
		websites,
		'America/New_York',
		label
	);
	expect(hours.find((r) => r.bundleId === 'web:video.example')).toMatchObject({
		hour: 9,
		seconds: 1200
	});
	expect(hours.find((r) => r.bundleId === 'com.apple.mobilesafari' && r.hour === 9)?.seconds).toBe(
		592
	);
	expect(
		hours.filter((r) => r.bundleId === 'com.apple.mobilesafari' && r.hour === 10)[0].seconds
	).toBe(900);
	expect(hours.reduce((sum, r) => sum + r.seconds, 0)).toBe(3300);
});

it('shows website hour windows separately from exact sessions and keeps browser residuals honest', () => {
	const websites = [
		{
			...session(
				'2026-02-01T09:00:00Z',
				'2026-02-01T10:00:00Z',
				'web:video.example',
				'screen-phone'
			),
			seconds: 600
		}
	];
	const timed = withWebsiteHours(
		[
			session(
				'2026-02-01T08:45:00Z',
				'2026-02-01T10:15:00Z',
				'com.apple.mobilesafari',
				'focus-phone'
			),
			session('2026-02-01T09:10:00Z', '2026-02-01T09:20:00Z', 'com.example.notes', 'focus-phone')
		],
		websites,
		() => 'Phone'
	);
	const result = timelineByApp(timed, 'UTC', '2026-02-01', '2026-02-01', 'day');
	const site = result.points.find((p) => p.key === 'web:video.example')!;
	expect(site).toMatchObject({
		y: [9, 10],
		seconds: 600,
		resolution: 'hour',
		bundleId: 'web:video.example',
		startMs: Date.parse('2026-02-01T09:00:00Z'),
		endMs: Date.parse('2026-02-01T10:00:00Z')
	});
	const browser = result.points.filter((p) => p.key === 'com.apple.mobilesafari');
	expect(browser.map((p) => [p.y, p.seconds, p.resolution])).toEqual([
		[[8.75, 9], 900, undefined],
		[[9, 10], 3000, 'hour'],
		[[10, 10.25], 900, undefined]
	]);
	expect(result.points.reduce((sum, p) => sum + p.seconds, 0)).toBe(6000);
	expect(
		timelineByApp(timed, 'UTC', '2026-02-01', '2026-02-01', 'week', (k) => k, ['web:video.example'])
			.points
	).toHaveLength(1);
	expect(timelineByApp(timed, 'UTC', '2026-02-02', '2026-02-02', 'day').points).toHaveLength(0);
});

it('keeps repeated DST website hours distinct on the timeline and sums them in By hour', () => {
	const websites = [
		{
			...session('2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z', 'web:video.example'),
			seconds: 300
		},
		{
			...session('2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z', 'web:video.example'),
			seconds: 600
		}
	];
	const result = timelineByApp(
		withWebsiteHours([], websites, (k) => k),
		'America/New_York',
		'2026-11-01',
		'2026-11-01',
		'day'
	);
	expect(result.points.map((p) => p.y)).toEqual([
		[1, 2],
		[1, 2]
	]);
	expect(result.points.map((p) => p.seconds)).toEqual([300, 600]);
	expect(
		hourlyByApp(combineHourlyUsage([], websites, 'America/New_York', (k) => k)).series[0].data[1]
	).toBe(900);
});

it('uses actual browser overlap when recorded windows cross clock hours and preserves aggregate-only history', () => {
	const websites = [
		{
			...session('2026-02-01T09:30:00Z', '2026-02-01T10:30:00Z', 'web:video.example'),
			seconds: 1200
		}
	];
	const originals = [session('2026-02-01T10:00:00Z', '2026-02-01T10:20:00Z', 'com.apple.safari')];
	const focus = [
		{ device: 'phone', date: '2026-02-01', hour: 10, bundleId: 'com.apple.safari', seconds: 1200 }
	];
	const exact = combineHourlyUsage(focus, websites, 'UTC', (k) => k, originals);
	expect(exact.reduce((sum, r) => sum + r.seconds, 0)).toBe(1200);
	expect(exact).toEqual([
		expect.objectContaining({ bundleId: 'web:video.example', hour: 9, seconds: 1200 })
	]);
	const retained = combineHourlyUsage(
		[{ ...focus[0], seconds: 1800 }],
		websites,
		'UTC',
		(k) => k,
		originals
	);
	expect(retained.find((r) => r.bundleId === 'com.apple.safari')).toMatchObject({
		hour: 10,
		seconds: 600,
		overlapUnknown: true
	});
	expect(retained.reduce((sum, r) => sum + r.seconds, 0)).toBe(1800);
	const outside = combineHourlyUsage([{ ...focus[0], hour: 9 }], websites, 'UTC', (k) => k, [
		session('2026-02-01T09:00:00Z', '2026-02-01T09:20:00Z', 'com.apple.safari')
	]);
	expect(outside.reduce((sum, r) => sum + r.seconds, 0)).toBe(2400);
});
