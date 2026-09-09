import type { UsageCache } from './cache';

/** Aggregate-only history has no file provenance. Keep it as a conservative
 * floor while original files are recovered; never add overlapping totals. */
export function retainPreviousUsage(previous: UsageCache, incoming: UsageCache): UsageCache {
	const merge = <T extends { seconds: number }>(
		old: T[],
		fresh: T[],
		key: (row: T) => string
	): T[] => {
		const rows = new Map(old.map((row) => [key(row), row]));
		for (const row of fresh) {
			const prior = rows.get(key(row));
			if (!prior || row.seconds >= prior.seconds) rows.set(key(row), row);
		}
		return [...rows.values()];
	};
	return {
		...incoming,
		devices: { ...incoming.devices, ...previous.devices },
		rows: merge(previous.rows, incoming.rows, (r) =>
			JSON.stringify([r.source, r.device, r.date, r.bundleId])
		),
		hourly: merge(previous.hourly ?? [], incoming.hourly ?? [], (r) =>
			JSON.stringify([r.device, r.date, r.hour, r.bundleId])
		)
	};
}
