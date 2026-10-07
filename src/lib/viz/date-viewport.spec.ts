import { describe, expect, it } from 'vitest';
import {
	dayNumber,
	dateString,
	dateViewport,
	panViewport,
	moveSelection,
	readDateSelection
} from './date-viewport';

describe('bounded calendar viewport', () => {
	it('starts at the latest 90-day span regardless of archive size', () => {
		expect(dateViewport('2000-01-01', '2026-10-06')).toEqual({
			start: '2026-07-08',
			end: '2026-10-06'
		});
	});
	it('clamps short histories and anchors a restored historical selection', () => {
		expect(dateViewport('2026-10-01', '2026-10-06')).toEqual({
			start: '2026-10-01',
			end: '2026-10-06'
		});
		expect(dateViewport('2020-01-01', '2026-10-06', '2024-04-01')).toEqual({
			start: '2024-01-02',
			end: '2024-04-01'
		});
	});
	it('pans without shrinking at either archive boundary', () => {
		const view = { start: '2026-07-08', end: '2026-10-06' };
		expect(panViewport(view, -30, '2026-07-01', '2026-10-06')).toEqual({
			start: '2026-07-01',
			end: '2026-09-29'
		});
		expect(panViewport(view, 30, '2020-01-01', '2026-10-06')).toEqual(view);
	});
	it('moves a range preserving its width at hard bounds', () => {
		expect(
			moveSelection({ start: '2026-10-01', end: '2026-10-04' }, 20, '2026-01-01', '2026-10-06')
		).toEqual({ start: '2026-10-03', end: '2026-10-06' });
		expect(
			moveSelection({ start: '2026-01-02', end: '2026-01-04' }, -20, '2026-01-01', '2026-10-06')
		).toEqual({ start: '2026-01-01', end: '2026-01-03' });
	});
	it('uses calendar days across DST, leap days and single-day histories', () => {
		expect(dateString(dayNumber('2026-11-01') + 1)).toBe('2026-11-02');
		expect(dateString(dayNumber('2024-03-01') - 1)).toBe('2024-02-29');
		expect(dateViewport('2026-10-06', '2026-10-06')).toEqual({
			start: '2026-10-06',
			end: '2026-10-06'
		});
	});
});
describe('saved date selection', () => {
	it('retains valid custom dates and relative rules', () => {
		expect(
			readDateSelection({ preset: '', dateStart: '2024-02-29', dateEnd: '2024-03-01' })
		).toEqual({ preset: '', dateStart: '2024-02-29', dateEnd: '2024-03-01' });
		expect(readDateSelection({ preset: '7D', dateStart: '2020-01-01' })).toEqual({
			preset: '7D',
			dateStart: '',
			dateEnd: ''
		});
	});
	it('falls back for malformed, impossible, reversed, or missing custom dates', () => {
		for (const value of [
			null,
			{ preset: '' },
			{ preset: '', dateStart: '2026-02-29', dateEnd: '2026-03-01' },
			{ preset: '', dateStart: '2026-03-02', dateEnd: '2026-03-01' },
			{ preset: 'invalid' }
		]) {
			expect(readDateSelection(value)).toEqual({ preset: '90D', dateStart: '', dateEnd: '' });
		}
	});
});
