// knowledgeC.db extraction: /app/usage rows are absolute per-app usage
// sessions (Mac-only; rich on laptop-era snapshots through 2026-07-11).
// Timestamps are Cocoa seconds (Unix - 978307200).
//
// The SQL is run by the caller (sql.js in tests, bun:sqlite in the ingest
// CLI) so this module has no SQLite dependency of its own.

import type { UsageSession } from './intervals';

const COCOA_EPOCH_S = 978307200;

export const APP_USAGE_SQL = `SELECT ZVALUESTRING, ZSTARTDATE, ZENDDATE FROM ZOBJECT
	WHERE ZSTREAMNAME = '/app/usage' AND ZVALUESTRING IS NOT NULL
	  AND ZSTARTDATE IS NOT NULL AND ZENDDATE IS NOT NULL
	ORDER BY ZSTARTDATE`;

/** @param rows the result rows of APP_USAGE_SQL: [bundleId, start, end] */
export function extractAppUsageSessions(rows: Iterable<unknown[]>): UsageSession[] {
	const sessions: UsageSession[] = [];
	for (const [bundleId, start, end] of rows as Iterable<[string, number, number]>) {
		if (end <= start) continue;
		sessions.push({
			bundleId,
			startMs: Math.round((start + COCOA_EPOCH_S) * 1000),
			endMs: Math.round((end + COCOA_EPOCH_S) * 1000)
		});
	}
	return sessions;
}
