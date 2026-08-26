import { describe, expect, it } from 'vitest';
import { buildUsageCache } from './cache';
import type { FocusEvent } from './infocus';
import type { UsageSession } from './intervals';

const TZ = 'America/New_York';
const ev = (iso: string, bundleId: string, focus: boolean): FocusEvent => ({
	tsMs: Date.parse(iso),
	bundleId,
	focus
});
const session = (startIso: string, endIso: string, bundleId: string): UsageSession => ({
	bundleId,
	startMs: Date.parse(startIso),
	endMs: Date.parse(endIso)
});

describe('buildUsageCache', () => {
	it('derives per-device infocus rows and per-device knowledgec rows', () => {
		const cache = buildUsageCache({
			timeZone: TZ,
			importedAt: '2026-08-25T00:00:00Z',
			devices: { 'uuid-phone': 'iPhone', 'uuid-mac': 'MacBook' },
			focusEventsByDevice: {
				'uuid-phone': [
					ev('2026-01-05T15:00:00Z', 'com.example.a', true),
					ev('2026-01-05T15:01:00Z', 'com.example.a', false)
				]
			},
			knowledgecSessionsByDevice: {
				'uuid-mac': [session('2026-01-05T16:00:00Z', '2026-01-05T16:10:00Z', 'com.example.b')]
			}
		});
		expect(cache).toEqual({
			version: 1,
			importedAt: '2026-08-25T00:00:00Z',
			timeZone: TZ,
			devices: { 'uuid-phone': 'iPhone', 'uuid-mac': 'MacBook' },
			// deterministic sort: date, then device, then bundle
			rows: [
				{
					source: 'knowledgec',
					device: 'uuid-mac',
					date: '2026-01-05',
					bundleId: 'com.example.b',
					seconds: 600
				},
				{
					source: 'infocus',
					device: 'uuid-phone',
					date: '2026-01-05',
					bundleId: 'com.example.a',
					seconds: 60
				}
			]
		});
	});

	it('dedupes knowledgec sessions repeated across overlapping snapshots', () => {
		const s = session('2026-01-05T16:00:00Z', '2026-01-05T16:10:00Z', 'com.example.b');
		const cache = buildUsageCache({
			timeZone: TZ,
			importedAt: '2026-08-25T00:00:00Z',
			devices: {},
			focusEventsByDevice: {},
			knowledgecSessionsByDevice: { 'uuid-mac': [s, { ...s }, { ...s }] }
		});
		expect(cache.rows).toEqual([
			{
				source: 'knowledgec',
				device: 'uuid-mac',
				date: '2026-01-05',
				bundleId: 'com.example.b',
				seconds: 600
			}
		]);
	});
});
