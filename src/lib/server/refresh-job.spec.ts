import { describe, expect, it } from 'vitest';
import { newJob, updateJob, jobStatus } from './refresh-job';

const start = '2026-01-01T00:00:00.000Z';
const now = (seconds: number) => new Date(Date.parse(start) + seconds * 1000).toISOString();
describe('confirmed refresh progress', () => {
	it('only accepts stage updates from the claimed attempt and never regresses import to copying', () => {
		let job = newJob('request', 'dump', start);
		job = updateJob(job, { requestId: 'request', runId: 'run', stage: 'accepted' }, now(1))!;
		expect(
			updateJob(job, { requestId: 'other', runId: 'run', stage: 'copying' }, now(2))
		).toBeNull();
		expect(
			updateJob(job, { requestId: 'request', runId: 'old', stage: 'copying' }, now(2))
		).toBeNull();
		job = updateJob(
			job,
			{ requestId: 'request', runId: 'run', stage: 'importing', detail: 'Checking files' },
			now(3)
		)!;
		expect(
			updateJob(job, { requestId: 'request', runId: 'run', stage: 'copying' }, now(4))
		).toBeNull();
		job = updateJob(job, { requestId: 'request', runId: 'run', stage: 'complete' }, now(5))!;
		expect(
			updateJob(job, { requestId: 'request', runId: 'run', stage: 'importing' }, now(6))
		).toBeNull();
		expect(jobStatus(job, Date.parse(now(6)))).toMatchObject({ phase: 'idle', stage: 'complete' });
	});
	it('shows stale heartbeats as unconfirmed before making a crashed attempt retryable', () => {
		const job = updateJob(
			newJob('request', 'dump', start),
			{ requestId: 'request', runId: 'run', stage: 'accepted' },
			now(1)
		)!;
		expect(jobStatus(job, Date.parse(now(20)))).toMatchObject({
			phase: 'running',
			confirmed: true,
			pending: false
		});
		expect(jobStatus(job, Date.parse(now(70)))).toMatchObject({
			phase: 'running',
			confirmed: false,
			pending: false
		});
		expect(jobStatus(job, Date.parse(now(1900)))).toMatchObject({
			confirmed: false,
			pending: true
		});
	});
	it('keeps retry timing in the shared record and rejects a premature second attempt', () => {
		let job = updateJob(
			newJob('request', 'dump', start),
			{ requestId: 'request', runId: 'run', stage: 'accepted' },
			now(1)
		)!;
		job = updateJob(
			job,
			{
				requestId: 'request',
				runId: 'run',
				stage: 'retrying',
				retryAt: now(301),
				detail: 'Read failed'
			},
			now(2)
		)!;
		expect(jobStatus(job, Date.parse(now(3)))).toMatchObject({
			phase: 'failed',
			retryAt: now(301),
			pending: false
		});
		expect(
			updateJob(job, { requestId: 'request', runId: 'next', stage: 'accepted' }, now(5))
		).toBeNull();
		expect(
			updateJob(job, { requestId: 'request', runId: 'next', stage: 'accepted' }, now(302))
		).toMatchObject({ runId: 'next', stage: 'accepted' });
	});
});
