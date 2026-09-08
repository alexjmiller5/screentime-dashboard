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

	/** Public, cookie-less endpoint - no credential needed to ask. */
	static async pending(baseUrl: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
		const res = await fetchFn(new URL('/api/refresh/pending', baseUrl));
		if (!res.ok) throw new Error(`pending ${res.status}`);
		return ((await res.json()) as { pending: boolean }).pending === true;
	}
}
