import { describe, expect, it } from 'vitest';
import { parseMarker, markerBucketIndex, assignLane } from './markers';

describe('marker validation', () => {
	it('trims a title and accepts a leap day', () => {
		expect(parseMarker({ date: '2024-02-29', title: '  Example event  ' })).toEqual({
			date: '2024-02-29',
			title: 'Example event'
		});
	});
	it.each([
		null,
		[],
		{},
		{ date: '2023-02-29', title: 'Event' },
		{ date: '2024-04-31', title: 'Event' },
		{ date: '2024-2-01', title: 'Event' },
		{ date: '0000-01-01', title: 'Event' },
		{ date: '2024-01-01', title: '  ' },
		{ date: '2024-01-01', title: 42 },
		{ date: '2024-01-01', title: 'a'.repeat(201) }
	])('rejects invalid input %j', (input) => {
		expect(() => parseMarker(input)).toThrow();
	});
});

describe('marker buckets', () => {
	it('omits dates outside daily data', () => {
		expect(markerBucketIndex('2024-01-02', ['2024-01-01'], 'day')).toBe(-1);
	});
	it('maps Sunday and Monday to different Monday-anchored weeks', () => {
		const dates = ['2024-01-01', '2024-01-08'];
		expect(markerBucketIndex('2024-01-07', dates, 'week')).toBe(0);
		expect(markerBucketIndex('2024-01-08', dates, 'week')).toBe(1);
	});
	it('maps leap days to their month', () => {
		expect(markerBucketIndex('2024-02-29', ['2024-01', '2024-02'], 'month')).toBe(1);
	});
});

it('separates overlapping labels but reuses free lanes', () => {
	const placed = [{ lane: 0, left: 10, right: 100 }];
	expect(assignLane(placed, 50, 150)).toBe(1);
	expect(assignLane(placed, 100, 150)).toBe(0);
});
