// Dashboard API client for the ingest job: turns a built cache into chunked
// /api/ingest calls (small bodies keep every Worker invocation cheap) behind
// Cloudflare Access service-token headers. Pure planning is unit-tested.

import type { UsageCache } from '../lib/data/cache';
import type { IngestChunk } from '../lib/server/store';

export const ROWS_PER_CHUNK = 2000;

export interface Credential {
	clientId: string;
	clientSecret: string;
}

/** Chunk plan for one run: started marker, row chunks, then the final sweep. */
export function planChunks(cache: UsageCache, runId: string): IngestChunk[] {
	const chunks: IngestChunk[] = [];
	const rows = cache.rows;
	const hourly = cache.hourly ?? [];
	for (let i = 0; i < rows.length; i += ROWS_PER_CHUNK) {
		chunks.push({ runId, rows: rows.slice(i, i + ROWS_PER_CHUNK) });
	}
	for (let i = 0; i < hourly.length; i += ROWS_PER_CHUNK) {
		chunks.push({ runId, hourly: hourly.slice(i, i + ROWS_PER_CHUNK) });
	}
	chunks.push({ runId, timeZone: cache.timeZone, devices: cache.devices, final: true });
	return chunks;
}

export class DashboardClient {
	constructor(
		private readonly baseUrl: string,
		private readonly credential: Credential,
		private readonly fetchFn: typeof fetch = fetch
	) {}

	async post(chunk: IngestChunk): Promise<void> {
		const res = await this.fetchFn(new URL('/api/ingest', this.baseUrl), {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'CF-Access-Client-Id': this.credential.clientId,
				'CF-Access-Client-Secret': this.credential.clientSecret
			},
			body: JSON.stringify(chunk)
		});
		if (!res.ok) throw new Error(`ingest ${res.status}: ${(await res.text()).slice(0, 200)}`);
	}

	/** Public, cookie-less endpoint - no credential needed to ask. With
	 * `waitSeconds` the Worker holds the request (long-poll, max 30s) and
	 * answers the moment a refresh is requested. */
	static async pending(
		baseUrl: string,
		fetchFn: typeof fetch = fetch,
		waitSeconds = 0
	): Promise<PendingRequest | null> {
		const u = new URL('/api/refresh/pending', baseUrl);
		if (waitSeconds > 0) u.searchParams.set('wait', String(waitSeconds));
		const res = await fetchFn(u);
		if (!res.ok) throw new Error(`pending ${res.status}`);
		const body = (await res.json()) as { pending: boolean; requestedAt?: string; kind?: string };
		if (body.pending !== true) return null;
		return {
			id: body.requestedAt ?? 'unknown',
			kind: body.kind === 'rebuild' ? 'rebuild' : 'dump'
		};
	}
}

export interface PendingRequest {
	/** The request's identity (its requestedAt). */
	id: string;
	/** dump = fresh snapshot first; rebuild = re-parse existing snapshots. */
	kind: 'dump' | 'rebuild';
}

/** What the job remembers about the request it is working on. */
export interface AttemptState {
	id: string;
	/** Attempts made so far (>= 1 once anything ran). */
	attempts: number;
	/** Epoch ms before which no further attempt is made. */
	nextAttemptAt: number;
}

/** Bounded, growing gaps between attempts at the same request. Every attempt
 * may cost a credential read, so the total is capped: 1 + RETRY_DELAYS.length
 * attempts, then the request is left alone until a new one arrives. */
export const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];

export type AttemptPlan =
	{ action: 'attempt' } | { action: 'wait'; ms: number } | { action: 'exhausted' };

export function planAttempt(
	pending: PendingRequest,
	state: AttemptState | null,
	now: number
): AttemptPlan {
	if (state === null || state.id !== pending.id) return { action: 'attempt' };
	if (state.attempts > RETRY_DELAYS_MS.length) return { action: 'exhausted' };
	if (now < state.nextAttemptAt) return { action: 'wait', ms: state.nextAttemptAt - now };
	return { action: 'attempt' };
}

/** State after an attempt at `pending` that did NOT resolve it. */
export function afterFailedAttempt(
	pending: PendingRequest,
	state: AttemptState | null,
	now: number
): AttemptState {
	const attempts = (state?.id === pending.id ? state.attempts : 0) + 1;
	const delay = RETRY_DELAYS_MS[attempts - 1] ?? Number.POSITIVE_INFINITY;
	return { id: pending.id, attempts, nextAttemptAt: now + delay };
}
