import { expect, it } from 'vitest';
import { hourlyByApp, timelineByApp, sessionTime } from './rhythm';

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
