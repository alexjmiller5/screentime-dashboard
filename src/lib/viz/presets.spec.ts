import { describe, expect, it } from 'vitest';
import { addDays, getPresetRange, PRESET_LABELS } from './presets';

describe('addDays', () => {
	it('does calendar-day arithmetic across month boundaries', () => {
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
		expect(addDays('2026-08-27', -7)).toBe('2026-08-20');
		expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
	});
});

describe('getPresetRange', () => {
	const min = '2026-05-06';
	const max = '2026-08-27';

	it('anchors relative presets to the data end', () => {
		expect(getPresetRange('7D', min, max)).toEqual({ start: '2026-08-20', end: max });
		expect(getPresetRange('30D', min, max)).toEqual({ start: '2026-07-28', end: max });
		expect(getPresetRange('90D', min, max)).toEqual({ start: '2026-05-29', end: max });
	});

	it('computes MTD, YTD and ALL', () => {
		expect(getPresetRange('MTD', min, max)).toEqual({ start: '2026-08-01', end: max });
		expect(getPresetRange('YTD', min, max)).toEqual({ start: min, end: max }); // clamped
		expect(getPresetRange('ALL', min, max)).toEqual({ start: min, end: max });
	});

	it('clamps starts before the data begins', () => {
		expect(getPresetRange('1Y', min, max).start).toBe(min);
	});

	it('every label produces a valid range', () => {
		for (const label of PRESET_LABELS) {
			const { start, end } = getPresetRange(label, min, max);
			expect(start >= min).toBe(true);
			expect(end).toBe(max);
			expect(start <= end).toBe(true);
		}
	});
});
