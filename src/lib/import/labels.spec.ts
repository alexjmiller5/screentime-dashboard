import { describe, expect, it } from 'vitest';
import { guessLabels, isPlaceholder } from './labels';
import type { ImportResult } from './importer';

const ev = (bundleId: string) => ({ tsMs: 0, bundleId, focus: true });
const scan = (partial: Partial<ImportResult>): ImportResult => ({
	snapshots: [],
	errors: [],
	focusEventsByDevice: {},
	knowledgecSessionsByDevice: {},
	deviceActivityByDevice: {},
	...partial
});

describe('guessLabels', () => {
	it('keeps real prior labels, replaces placeholders with platform guesses', () => {
		const labels = guessLabels(
			scan({
				focusEventsByDevice: {
					'AAAAAAAA-1': [ev('com.apple.springboard')],
					'BBBBBBBB-2': [ev('com.apple.finder')],
					'CCCCCCCC-3': [ev('com.apple.loginwindow')],
					'DDDDDDDD-4': [ev('com.example.unknown')]
				},
				knowledgecSessionsByDevice: { knowledgec: [{ bundleId: 'x', startMs: 0, endMs: 1 }] }
			}),
			{ 'AAAAAAAA-1': 'My phone', 'BBBBBBBB-2': 'BBBBBBBB' }
		);
		expect(labels).toEqual({
			'AAAAAAAA-1': 'My phone',
			'BBBBBBBB-2': 'Mac',
			'CCCCCCCC-3': 'Mac (CCCCCCCC)',
			'DDDDDDDD-4': 'DDDDDDDD',
			knowledgec: 'Mac'
		});
	});

	it('guesses Screen Time devices from their activity entries and skips empty devices', () => {
		const labels = guessLabels(
			scan({
				deviceActivityByDevice: {
					'EEEEEEEE-5': [
						{ cocoaSeconds: 0, entries: [{ key: 'com.apple.mobilesafari', seconds: 1 }] }
					],
					'FFFFFFFF-6': []
				}
			})
		);
		expect(labels).toEqual({ 'EEEEEEEE-5': 'iPhone' });
	});

	it('isPlaceholder recognizes machine labels only', () => {
		expect(isPlaceholder('aaaaaaaa', 'AAAAAAAA-1')).toBe(true);
		expect(isPlaceholder('Mac (AAAAAAAA)', 'AAAAAAAA-1')).toBe(true);
		expect(isPlaceholder('iPhone', 'AAAAAAAA-1')).toBe(false);
	});
});
