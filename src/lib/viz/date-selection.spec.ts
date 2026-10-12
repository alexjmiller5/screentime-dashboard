import { describe, expect, it } from 'vitest';
import { readDateSelection } from './date-selection';

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
