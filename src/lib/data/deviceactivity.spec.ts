import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBplist } from './bplist';
import { extractSegmentActivities, segmentsToRows } from './deviceactivity';

const segment = parseBplist(
	new Uint8Array(readFileSync(new URL('./fixtures/segment.bplist', import.meta.url)))
);

describe('extractSegmentActivities', () => {
	it('flattens apps and web domains across categories', () => {
		expect(extractSegmentActivities(segment)).toEqual([
			{ key: 'web:example-movies.test', seconds: 3558.5 },
			{ key: 'web:ads.example.test', seconds: 1.75 },
			{ key: 'com.example.browser.ios', seconds: 3594.25 }
		]);
	});

	it('returns empty for a shape without categoryActivities', () => {
		expect(extractSegmentActivities({ value: {} })).toEqual([]);
		expect(extractSegmentActivities(null)).toEqual([]);
	});
});

describe('segmentsToRows', () => {
	it('turns per-device daily segments into dated screentime rows', () => {
		// 809409600 cocoa = 2026-08-26T04:00:00Z = Aug 26 in New York
		const rows = segmentsToRows(
			{
				'device-1': [
					{ cocoaSeconds: 809409600, entries: extractSegmentActivities(segment) },
					{ cocoaSeconds: 809323200, entries: [{ key: 'com.example.browser.ios', seconds: 60.4 }] }
				]
			},
			'America/New_York'
		);
		expect(rows).toEqual([
			{
				source: 'screentime',
				device: 'device-1',
				date: '2026-08-25',
				bundleId: 'com.example.browser.ios',
				seconds: 60
			},
			{
				source: 'screentime',
				device: 'device-1',
				date: '2026-08-26',
				bundleId: 'web:example-movies.test',
				seconds: 3559
			},
			{
				source: 'screentime',
				device: 'device-1',
				date: '2026-08-26',
				bundleId: 'web:ads.example.test',
				seconds: 2
			},
			{
				source: 'screentime',
				device: 'device-1',
				date: '2026-08-26',
				bundleId: 'com.example.browser.ios',
				seconds: 3594
			}
		]);
	});
});
