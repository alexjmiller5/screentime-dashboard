import { describe, expect, it } from 'vitest';
import { deriveDailyUsage, deriveHourlyUsage } from './intervals';
import type { FocusEvent } from './infocus';

const TZ = 'America/New_York';
const at = (iso: string): number => Date.parse(iso);
const ev = (iso: string, bundleId: string, focus: boolean): FocusEvent => ({
	tsMs: at(iso),
	bundleId,
	focus
});

describe('deriveDailyUsage', () => {
	it('sums focus->unfocus sessions into per-bundle daily seconds', () => {
		const usage = deriveDailyUsage(
			[
				ev('2026-01-05T15:00:00Z', 'com.example.a', true),
				ev('2026-01-05T15:00:30Z', 'com.example.a', false),
				ev('2026-01-05T16:00:00Z', 'com.example.a', true),
				ev('2026-01-05T16:01:00Z', 'com.example.a', false),
				ev('2026-01-05T15:00:30Z', 'com.example.b', true),
				ev('2026-01-05T15:00:40Z', 'com.example.b', false)
			],
			{ timeZone: TZ }
		);
		expect(usage).toEqual([
			{ date: '2026-01-05', bundleId: 'com.example.a', seconds: 90 },
			{ date: '2026-01-05', bundleId: 'com.example.b', seconds: 10 }
		]);
	});

	it('buckets by the given time zone, not UTC', () => {
		// 03:00 UTC on Jan 5 is 22:00 on Jan 4 in New York
		const usage = deriveDailyUsage(
			[
				ev('2026-01-05T03:00:00Z', 'com.example.a', true),
				ev('2026-01-05T03:00:10Z', 'com.example.a', false)
			],
			{ timeZone: TZ }
		);
		expect(usage).toEqual([{ date: '2026-01-04', bundleId: 'com.example.a', seconds: 10 }]);
	});

	it('splits a session crossing local midnight across both days', () => {
		// 04:59:00-05:01:00 UTC = 23:59:00-00:01:00 New York
		const usage = deriveDailyUsage(
			[
				ev('2026-01-05T04:59:00Z', 'com.example.a', true),
				ev('2026-01-05T05:01:00Z', 'com.example.a', false)
			],
			{ timeZone: TZ }
		);
		expect(usage).toEqual([
			{ date: '2026-01-04', bundleId: 'com.example.a', seconds: 60 },
			{ date: '2026-01-05', bundleId: 'com.example.a', seconds: 60 }
		]);
	});

	it('closes an unclosed session when the same bundle regains focus', () => {
		const usage = deriveDailyUsage(
			[
				ev('2026-01-05T15:00:00Z', 'com.example.a', true),
				ev('2026-01-05T15:00:20Z', 'com.example.a', true),
				ev('2026-01-05T15:00:30Z', 'com.example.a', false)
			],
			{ timeZone: TZ }
		);
		expect(usage).toEqual([{ date: '2026-01-05', bundleId: 'com.example.a', seconds: 30 }]);
	});

	it('ignores an unfocus with no open session', () => {
		expect(
			deriveDailyUsage([ev('2026-01-05T15:00:00Z', 'com.example.a', false)], { timeZone: TZ })
		).toEqual([]);
	});

	it('caps runaway sessions (lost unfocus events)', () => {
		const usage = deriveDailyUsage(
			[
				ev('2026-01-05T15:00:00Z', 'com.example.a', true),
				ev('2026-01-05T23:00:00Z', 'com.example.a', false)
			],
			{ timeZone: TZ, maxSessionMs: 60 * 60 * 1000 }
		);
		expect(usage).toEqual([{ date: '2026-01-05', bundleId: 'com.example.a', seconds: 3600 }]);
	});

	it('dedupes identical events from overlapping snapshots and tombstones', () => {
		const events = [
			ev('2026-01-05T15:00:00Z', 'com.example.a', true),
			ev('2026-01-05T15:00:30Z', 'com.example.a', false)
		];
		const usage = deriveDailyUsage([...events, ...events, events[0]], { timeZone: TZ });
		expect(usage).toEqual([{ date: '2026-01-05', bundleId: 'com.example.a', seconds: 30 }]);
	});
});

describe('deriveHourlyUsage', () => {
	it('slices sessions into per-hour buckets in the target time zone', () => {
		// 14:30-16:15 UTC = 09:30-11:15 New York (EST, UTC-5)
		const usage = deriveHourlyUsage(
			[
				ev('2026-01-05T14:30:00Z', 'com.example.a', true),
				ev('2026-01-05T16:15:00Z', 'com.example.a', false)
			],
			{ timeZone: TZ }
		);
		expect(usage).toEqual([
			{ date: '2026-01-05', hour: 9, bundleId: 'com.example.a', seconds: 1800 },
			{ date: '2026-01-05', hour: 10, bundleId: 'com.example.a', seconds: 3600 },
			{ date: '2026-01-05', hour: 11, bundleId: 'com.example.a', seconds: 900 }
		]);
	});

	it('crosses local midnight into the next date', () => {
		// 04:30-05:30 UTC = 23:30-00:30 New York
		const usage = deriveHourlyUsage(
			[
				ev('2026-01-05T04:30:00Z', 'com.example.a', true),
				ev('2026-01-05T05:30:00Z', 'com.example.a', false)
			],
			{ timeZone: TZ }
		);
		expect(usage).toEqual([
			{ date: '2026-01-04', hour: 23, bundleId: 'com.example.a', seconds: 1800 },
			{ date: '2026-01-05', hour: 0, bundleId: 'com.example.a', seconds: 1800 }
		]);
	});
});
