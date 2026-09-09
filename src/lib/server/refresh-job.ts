import type { RefreshKind, RefreshStatus } from './store';

export type JobStage =
	'requested' | 'accepted' | 'copying' | 'importing' | 'complete' | 'retrying' | 'failed';
export interface RefreshJob {
	requestId: string;
	kind: RefreshKind;
	requestedAt: string;
	stage: JobStage;
	runId?: string;
	startedAt?: string;
	heartbeatAt?: string;
	finishedAt?: string;
	retryAt?: string;
	detail?: string;
}
export interface JobUpdate {
	requestId: string;
	runId: string;
	stage: Exclude<JobStage, 'requested'> | 'heartbeat';
	detail?: string;
	retryAt?: string;
}
const ACTIVE = ['accepted', 'copying', 'importing'];
const STALE_MS = 30 * 60_000;
export const newJob = (requestId: string, kind: RefreshKind, requestedAt: string): RefreshJob => ({
	requestId,
	kind,
	requestedAt,
	stage: 'requested'
});

export function jobStatus(job: RefreshJob, now: number): RefreshStatus {
	const age = now - Date.parse(job.heartbeatAt ?? job.requestedAt);
	const active = ACTIVE.includes(job.stage);
	return {
		requestId: job.requestId,
		kind: job.kind,
		requestedAt: job.requestedAt,
		startedAt: job.startedAt,
		importedAt: job.finishedAt,
		stage: job.stage,
		heartbeatAt: job.heartbeatAt,
		confirmed: active && age < 60_000,
		retryAt: job.retryAt,
		detail: job.detail,
		pending:
			job.stage === 'requested' ||
			(active && age > STALE_MS) ||
			(job.stage === 'retrying' && now >= Date.parse(job.retryAt!)),
		phase:
			job.stage === 'complete'
				? 'idle'
				: active
					? 'running'
					: job.stage === 'requested'
						? 'requested'
						: 'failed',
		...(job.stage === 'failed' || job.stage === 'retrying' ? { error: job.detail } : {})
	};
}

/** Only the current attempt can report progress. Late messages cannot finish
 * a replacement job or move an import back to the backup stage. */
export function updateJob(job: RefreshJob, update: JobUpdate, now: string): RefreshJob | null {
	if (job.requestId !== update.requestId) return null;
	if (update.stage === 'accepted') {
		if (!jobStatus(job, Date.parse(now)).pending) return null;
		return {
			...newJob(job.requestId, job.kind, job.requestedAt),
			runId: update.runId,
			stage: 'accepted',
			startedAt: now,
			heartbeatAt: now
		};
	}
	if (job.runId !== update.runId || !ACTIVE.includes(job.stage)) return null;
	if (job.stage === 'importing' && update.stage === 'copying') return null;
	if (update.stage === 'heartbeat') {
		// The watcher only confirms the backup process. Import heartbeats come
		// from the importer itself, so a hung parser cannot look healthy.
		return job.stage === 'importing' ? null : { ...job, heartbeatAt: now };
	}
	return {
		...job,
		stage: update.stage,
		heartbeatAt: now,
		...(update.detail !== undefined ? { detail: update.detail } : {}),
		...(update.stage === 'complete' ? { finishedAt: now } : {}),
		...(update.stage === 'retrying' ? { retryAt: update.retryAt } : {})
	};
}

export function validJobUpdate(value: unknown): value is JobUpdate {
	if (!value || typeof value !== 'object') return false;
	const v = value as JobUpdate;
	return (
		typeof v.requestId === 'string' &&
		v.requestId.length > 0 &&
		v.requestId.length <= 100 &&
		typeof v.runId === 'string' &&
		v.runId.length > 0 &&
		v.runId.length <= 100 &&
		['accepted', 'copying', 'importing', 'complete', 'retrying', 'failed', 'heartbeat'].includes(
			v.stage
		) &&
		(v.detail === undefined || (typeof v.detail === 'string' && v.detail.length <= 500)) &&
		(v.stage !== 'retrying' ||
			(typeof v.retryAt === 'string' && Number.isFinite(Date.parse(v.retryAt))))
	);
}

export async function readJob(db: D1Database): Promise<RefreshJob | null> {
	const row = await db
		.prepare("SELECT value FROM meta WHERE key = 'refresh_job'")
		.first<{ value: string }>();
	return row ? (JSON.parse(row.value) as RefreshJob) : null;
}

/** The single meta row is updated with compare-and-swap, so simultaneous
 * tabs and competing attempts always converge on one shared job. */
export async function writeJob(
	db: D1Database,
	previous: RefreshJob | null,
	next: RefreshJob
): Promise<boolean> {
	const result = previous
		? await db
				.prepare("UPDATE meta SET value = ? WHERE key = 'refresh_job' AND value = ?")
				.bind(JSON.stringify(next), JSON.stringify(previous))
				.run()
		: await db
				.prepare(
					"INSERT INTO meta (key, value) VALUES ('refresh_job', ?) ON CONFLICT (key) DO NOTHING"
				)
				.bind(JSON.stringify(next))
				.run();
	return result.meta.changes === 1;
}
