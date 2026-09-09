import { expect, it } from 'vitest';
import { refreshMessage } from './refresh-status';

it('distinguishes confirmed work, stale updates, scheduled retries and completion', () => {
	const base = {
		kind: 'dump' as const,
		pending: false,
		phase: 'running' as const,
		requestedAt: '2026-01-01T00:00:00.000Z',
		heartbeatAt: '2026-01-01T00:00:10.000Z'
	};
	const now = Date.parse('2026-01-01T00:00:20.000Z');
	expect(refreshMessage({ ...base, stage: 'copying', confirmed: true }, now)).toContain(
		'Creating backup'
	);
	expect(refreshMessage({ ...base, stage: 'copying', confirmed: true }, now)).toContain(
		'confirmed 10s ago'
	);
	expect(refreshMessage({ ...base, stage: 'copying', confirmed: false }, now)).toContain(
		'Progress unconfirmed'
	);
	expect(
		refreshMessage({ ...base, stage: 'retrying', retryAt: '2026-01-01T00:05:20.000Z' }, now)
	).toContain('Retry in 5 min');
	expect(
		refreshMessage({ ...base, stage: 'complete', detail: '3 imported, 2 skipped' }, now)
	).toContain('3 imported');
});
