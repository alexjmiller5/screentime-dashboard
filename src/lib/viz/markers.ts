import type { Bucket } from './series';
import { addDays } from './presets';

export interface Marker {
	id: string;
	date: string;
	title: string;
}
export type MarkerInput = Omit<Marker, 'id'>;
export const MARKER_TITLE_MAX = 200;

/** Validate calendar dates without accepting Date's rollover of impossible days. */
export function parseMarker(value: unknown): MarkerInput {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Provide a date and title.');
	const { date, title } = value as Record<string, unknown>;
	if (
		typeof date !== 'string' ||
		!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
		date.startsWith('0000') ||
		!Number.isFinite(Date.parse(date)) ||
		new Date(date).toISOString().slice(0, 10) !== date
	) {
		throw new Error('Choose a valid date (YYYY-MM-DD).');
	}
	if (typeof title !== 'string' || !title.trim() || title.trim().length > MARKER_TITLE_MAX)
		throw new Error(`Enter a title of 1-${MARKER_TITLE_MAX} characters.`);
	return { date, title: title.trim() };
}

/** Aggregated views anchor to the containing bucket; tooltips retain the exact date. */
export function markerBucketIndex(date: string, dates: string[], bucket: Bucket): number {
	let label = date;
	if (bucket === 'month') label = date.slice(0, 7);
	if (bucket === 'week') label = addDays(date, -((new Date(date).getUTCDay() + 6) % 7));
	return dates.indexOf(label);
}

// Same greedy label-lane placement as the sibling task dashboard.
export function assignLane(
	placed: { lane: number; left: number; right: number }[],
	left: number,
	right: number
): number {
	for (let lane = 0; ; lane++) {
		if (!placed.some((p) => p.lane === lane && left < p.right && right > p.left)) return lane;
	}
}

/** Match the text-width placement used by the task burndown markers. */
export function markerLabelBounds(x: number, textWidth: number, min: number, max: number) {
	const width = Math.min(textWidth + 8, 140, max - min);
	return { left: Math.max(min, Math.min(x - width / 2, max - width)), width };
}
