import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSegb } from './segb';
import { extractFocusEvents } from './infocus';

const fixture = new Uint8Array(readFileSync(new URL('./fixtures/infocus.segb', import.meta.url)));

describe('extractFocusEvents', () => {
	const events = extractFocusEvents(parseSegb(fixture));

	it('reads bundle id, focus flag, and the precise payload timestamp', () => {
		expect(events[0]).toEqual({
			tsMs: Date.parse('2026-01-05T09:00:00.250Z'),
			bundleId: 'com.example.appone',
			focus: true
		});
		expect(events[1]).toEqual({
			tsMs: Date.parse('2026-01-05T09:00:30.750Z'),
			bundleId: 'com.example.appone',
			focus: false
		});
	});

	it('keeps events from deleted (tombstoned) records - they extend coverage', () => {
		expect(events.some((e) => e.bundleId === 'com.example.springboard.home')).toBe(true);
	});

	it('yields one event per record, including duplicated-metadata records', () => {
		// 7 fixture records, all with valid payloads
		expect(events).toHaveLength(7);
	});

	it('skips records whose payload has no bundle id or timestamp', () => {
		const garbage = [
			{ timestampMs: 0, state: 1, crcPassed: true, data: new Uint8Array([0xff, 0x01, 0x02]) }
		];
		expect(extractFocusEvents(garbage)).toEqual([]);
	});
});
