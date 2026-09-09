import { describe, expect, it } from 'vitest';
import { readSavedApps, isSavedAppsActive } from './saved-apps';

describe('saved app selection', () => {
	it('captures an existing selection and validates saved preferences', () => {
		expect(readSavedApps(undefined, ['app-a', 'site.example'])).toEqual(['app-a', 'site.example']);
		expect(readSavedApps(['app-a', 'app-a'], [])).toEqual(['app-a']);
		expect(readSavedApps([42], ['app-b'])).toEqual(['app-b']);
	});
	it('is active only for the exact selection, all devices, and daily buckets', () => {
		expect(isSavedAppsActive(['b', 'a'], ['a', 'b'], [], 'day')).toBe(true);
		expect(isSavedAppsActive(['a'], ['a', 'b'], [], 'day')).toBe(false);
		expect(isSavedAppsActive(['a'], ['a'], ['device'], 'day')).toBe(false);
		expect(isSavedAppsActive(['a'], ['a'], [], 'week')).toBe(false);
		expect(isSavedAppsActive([], [], [], 'day')).toBe(false);
	});
});
