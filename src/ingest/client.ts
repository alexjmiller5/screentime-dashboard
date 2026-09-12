// Dashboard API client for the ingest job: turns a built cache into chunked
// /api/ingest calls (small bodies keep every Worker invocation cheap) behind
// Cloudflare Access service-token headers. Pure planning is unit-tested.

import type { IngestChunk, RefreshStatus } from '../lib/server/store';
import type { JobUpdate } from '../lib/server/refresh-job';
import type { FetchFn } from '../lib/import/incremental';

export type Credential = ({ token: string } | { clientId: string; clientSecret: string }) & {
	/** Optional headers for a caller's existing proxy. */
	headers?: Record<string, string>;
};

/** Both import uploads and job updates use the same authenticated transport. */
export function authenticatedFetch(
	baseUrl: string,
	credential: Credential,
	fetchFn: typeof fetch = fetch
): FetchFn {
	return async (input, init) => {
		const request = new Request(input instanceof Request ? input : new URL(input, baseUrl), init);
		const url = new URL(request.url);
		if (url.origin !== new URL(baseUrl).origin)
			throw new Error('Refusing to send credentials to another origin');
		if ('token' in credential) {
			if (!url.pathname.startsWith('/api/')) throw new Error('Dashboard API path required');
			url.pathname = url.pathname.replace(/^\/api\//, '/api/device/');
		}
		const headers = new Headers(request.headers);
		for (const [name, value] of Object.entries(credential.headers ?? {})) headers.set(name, value);
		if ('token' in credential) headers.set('Authorization', `Bearer ${credential.token}`);
		else {
			headers.set('CF-Access-Client-Id', credential.clientId);
			headers.set('CF-Access-Client-Secret', credential.clientSecret);
		}
		return fetchFn(new Request(url, request), { headers, redirect: 'error' });
	};
}

export class DashboardClient {
	constructor(
		private readonly baseUrl: string,
		private readonly credential: Credential,
		private readonly fetchFn: typeof fetch = fetch
	) {}

	async post(chunk: IngestChunk): Promise<void> {
		const res = await this.send('/api/ingest', chunk);
		if (!res.ok) throw new Error(`ingest ${res.status}: ${(await res.text()).slice(0, 200)}`);
	}

	async job(update: JobUpdate): Promise<boolean> {
		const res = await this.send('/api/refresh/job', update);
		if (res.status === 409) return false;
		if (!res.ok) throw new Error(`job update ${res.status}`);
		return true;
	}

	async status(): Promise<RefreshStatus> {
		const res = await this.send('/api/refresh');
		if (!res.ok) throw new Error(`refresh status ${res.status}`);
		return res.json() as Promise<RefreshStatus>;
	}

	private async send(path: string, body?: unknown): Promise<Response> {
		return authenticatedFetch(
			this.baseUrl,
			this.credential,
			this.fetchFn
		)(new URL(path, this.baseUrl), {
			method: body === undefined ? 'GET' : 'POST',
			signal: AbortSignal.timeout(15_000),
			redirect: 'error',
			headers: {
				'content-type': 'application/json'
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		});
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
		const body = (await res.json()) as {
			pending: boolean;
			id?: string;
			requestedAt?: string;
			kind?: string;
		};
		if (body.pending !== true) return null;
		return {
			id: body.id ?? body.requestedAt ?? 'unknown',
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
