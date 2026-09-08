// Device label prefill for a fresh scan: prior real label > platform guess >
// short uuid. Shared by the ingest CLI (labels for devices D1 doesn't know
// yet) - the dashboard's device dialog owns the labels afterwards.

import type { ImportResult } from './importer';
import { guessDeviceLabel } from './paths';

export const KNOWLEDGEC_DEVICE = 'knowledgec';

/** Machine-generated labels (uuid prefixes, suffixed guesses, the old
 * knowledgeC default) were never the user's words - a fresh guess may
 * replace them. Plain "iPhone"/"Mac"/anything typed stays. */
export function isPlaceholder(label: string, id: string): boolean {
	return (
		label.toUpperCase() === id.slice(0, 8).toUpperCase() ||
		/^(iPhone|Mac) \([0-9A-F]{8}\)$/i.test(label) ||
		label === 'Mac (knowledgeC)'
	);
}

/** Devices that carry data in this scan. */
export function scannedDevices(scan: ImportResult): string[] {
	const count = (id: string): number =>
		scan.focusEventsByDevice[id]?.length ??
		scan.knowledgecSessionsByDevice[id]?.length ??
		scan.deviceActivityByDevice[id]?.length ??
		0;
	return [
		...new Set([
			...Object.keys(scan.focusEventsByDevice),
			...Object.keys(scan.knowledgecSessionsByDevice),
			...Object.keys(scan.deviceActivityByDevice)
		])
	].filter((id) => count(id) > 0);
}

/** Entries sharing a guess merge on purpose ("iPhone" twice IS one iPhone);
 * only "Mac" gets uuid suffixes past the first, since several physical Macs
 * are likely. */
export function guessLabels(
	scan: ImportResult,
	prior: Record<string, string> = {}
): Record<string, string> {
	let macs = 0;
	return Object.fromEntries(
		scannedDevices(scan).map((id) => {
			const known = prior[id];
			if (known && !isPlaceholder(known, id)) return [id, known];
			if (id === KNOWLEDGEC_DEVICE) return [id, 'Mac'];
			// Screen Time devices have no focus events - guess from their
			// activity entries' bundle ids instead.
			const events =
				scan.focusEventsByDevice[id] ??
				(scan.deviceActivityByDevice[id] ?? []).flatMap((segment) =>
					segment.entries
						.filter((e) => !e.key.startsWith('web:'))
						.map((e) => ({ tsMs: 0, bundleId: e.key, focus: true }))
				);
			const guess = guessDeviceLabel(events);
			if (guess === null) return [id, id.slice(0, 8)];
			if (guess === 'Mac' && ++macs > 1) return [id, `Mac (${id.slice(0, 8)})`];
			return [id, guess];
		})
	);
}
