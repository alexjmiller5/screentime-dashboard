import { expect, it } from 'vitest';
import { retainPreviousUsage } from './retained';
import type { UsageCache } from './cache';

it('keeps historical rows and fuller totals while adopting newly recovered days', () => {
	const row = (date: string, seconds: number) => ({
		source: 'knowledgec' as const,
		device: 'd',
		date,
		bundleId: 'app',
		seconds
	});
	const previous: UsageCache = {
		version: 1,
		timeZone: 'UTC',
		importedAt: 'old',
		devices: { d: 'Custom' },
		rows: [row('2026-01-01', 100), row('2026-01-02', 200)]
	};
	const incoming: UsageCache = {
		...previous,
		importedAt: 'new',
		devices: { d: 'Guess' },
		rows: [row('2026-01-02', 50), row('2026-01-03', 300)]
	};
	const merged = retainPreviousUsage(previous, incoming);
	expect(merged.rows.map((r) => r.seconds)).toEqual([100, 200, 300]);
	expect(merged.devices.d).toBe('Custom');
	expect(merged.importedAt).toBe('new');
});
