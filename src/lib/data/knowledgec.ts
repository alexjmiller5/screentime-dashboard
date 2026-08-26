// knowledgeC.db extraction: /app/usage rows are absolute per-app usage
// sessions (Mac-only; rich on laptop-era snapshots through 2026-07-11).
// Timestamps are Cocoa seconds (Unix - 978307200).

import type { SqlJsStatic } from 'sql.js';
import type { UsageSession } from './intervals';

const COCOA_EPOCH_S = 978307200;

export function extractAppUsageSessions(SQL: SqlJsStatic, dbBytes: Uint8Array): UsageSession[] {
	const db = new SQL.Database(dbBytes);
	try {
		const sessions: UsageSession[] = [];
		const stmt = db.prepare(
			`SELECT ZVALUESTRING, ZSTARTDATE, ZENDDATE FROM ZOBJECT
			 WHERE ZSTREAMNAME = '/app/usage' AND ZVALUESTRING IS NOT NULL
			   AND ZSTARTDATE IS NOT NULL AND ZENDDATE IS NOT NULL
			 ORDER BY ZSTARTDATE`
		);
		while (stmt.step()) {
			const [bundleId, start, end] = stmt.get() as [string, number, number];
			if (end <= start) continue;
			sessions.push({
				bundleId,
				startMs: Math.round((start + COCOA_EPOCH_S) * 1000),
				endMs: Math.round((end + COCOA_EPOCH_S) * 1000)
			});
		}
		stmt.free();
		return sessions;
	} finally {
		db.close();
	}
}
