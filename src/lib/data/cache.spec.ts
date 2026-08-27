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
			hourly: [
				{
					device: 'uuid-phone',
					date: '2026-01-05',
					hour: 10,
					bundleId: 'com.example.a',
					seconds: 60
				}
			],
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

	it('adds DeviceActivity segments as screentime rows (apps + web domains)', () => {
		const cache = buildUsageCache({
			timeZone: TZ,
			importedAt: '2026-08-25T00:00:00Z',
			devices: {},
			focusEventsByDevice: {},
			knowledgecSessionsByDevice: {},
			deviceActivityByDevice: {
				'uuid-da': [
					{
						cocoaSeconds: 809409600, // 2026-08-26 in New York
						entries: [
							{ key: 'web:example-movies.test', seconds: 3558.5 },
							{ key: 'com.example.browser.ios', seconds: 3594.25 }
						]
					}
				]
			}
		});
		expect(cache.rows).toEqual([
			{
				source: 'screentime',
				device: 'uuid-da',
				date: '2026-08-26',
				bundleId: 'com.example.browser.ios',
				seconds: 3594
			},
			{
				source: 'screentime',
				device: 'uuid-da',
				date: '2026-08-26',
				bundleId: 'web:example-movies.test',
				seconds: 3559
			}
		]);
	});

	it('derives per-hour rows for the day grid (shell surfaces excluded)', () => {
		const cache = buildUsageCache({
			timeZone: TZ,
			importedAt: '2026-08-25T00:00:00Z',
			devices: {},
			focusEventsByDevice: {
				phone: [
					// 15:00-15:30 UTC = 10:00-10:30 New York (EDT... January: EST 10:00)
					ev('2026-01-05T15:00:00Z', 'com.example.a', true),
					ev('2026-01-05T15:30:00Z', 'com.example.a', false),
					ev('2026-01-05T15:00:00Z', 'com.apple.loginwindow', true),
					ev('2026-01-05T16:00:00Z', 'com.apple.loginwindow', false)
				]
			},
			knowledgecSessionsByDevice: {}
		});
		expect(cache.hourly).toEqual([
			{ device: 'phone', date: '2026-01-05', hour: 10, bundleId: 'com.example.a', seconds: 1800 }
		]);
	});

	it('drops system shell surfaces - lock screen and springboard are not usage', () => {
		// loginwindow keeps "focus" for entire lock periods (419h of fake usage
		// in the real archive) - shell bundles must never become rows.
		const shellBundles = [
			'com.apple.loginwindow',
			'com.apple.SpringBoard.transitionReason.homescreen',
			'com.apple.springboard.today-view',
			'com.apple.control-center',
			'com.apple.notificationcenterui'
		];
		const cache = buildUsageCache({
			timeZone: TZ,
			importedAt: '2026-08-25T00:00:00Z',
			devices: {},
			focusEventsByDevice: {
				phone: shellBundles.flatMap((b) => [
					ev('2026-01-05T15:00:00Z', b, true),
					ev('2026-01-05T15:30:00Z', b, false)
				])
			},
			knowledgecSessionsByDevice: {
				mac: [session('2026-01-05T16:00:00Z', '2026-01-05T18:00:00Z', 'com.apple.loginwindow')]
			}
		});
		expect(cache.rows).toEqual([]);
	});
});
