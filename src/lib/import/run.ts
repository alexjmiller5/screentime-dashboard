// Browser glue for the import flow: directory picker -> importBackups ->
// (caller labels devices) -> buildUsageCache -> PUT /api/usage.

import initSqlJs from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { importBackups, type ImportResult } from './importer';
import { buildUsageCache, type UsageCache } from '../data/cache';

export async function scanBackupsFolder(onProgress: (msg: string) => void): Promise<ImportResult> {
	const dir = await window.showDirectoryPicker();
	return importBackups(dir, {
		initSql: () => initSqlJs({ locateFile: () => sqlWasmUrl }),
		onProgress
	});
}

export async function uploadCache(
	scan: ImportResult,
	devices: Record<string, string>
): Promise<UsageCache> {
	const cache = buildUsageCache({
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		importedAt: new Date().toISOString(),
		devices,
		focusEventsByDevice: scan.focusEventsByDevice,
		knowledgecSessionsByDevice: scan.knowledgecSessionsByDevice,
		deviceActivityByDevice: scan.deviceActivityByDevice
	});
	const res = await fetch('/api/usage', { method: 'PUT', body: JSON.stringify(cache) });
	if (!res.ok) throw new Error(`upload failed: ${res.status}`);
	return cache;
}
