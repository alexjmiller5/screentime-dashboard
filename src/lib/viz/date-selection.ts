import { PRESET_LABELS } from './presets';
const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
const dateString = (day: number): string => new Date(day * 86_400_000).toISOString().slice(0, 10);

export function readDateSelection(value: unknown): {
	preset: string;
	dateStart: string;
	dateEnd: string;
} {
	const fallback = { preset: '90D', dateStart: '', dateEnd: '' };
	if (!value || typeof value !== 'object') return fallback;
	const p = value as Record<string, unknown>;
	if (PRESET_LABELS.includes(p.preset as (typeof PRESET_LABELS)[number]))
		return { ...fallback, preset: p.preset as string };
	const valid = (value: unknown): value is string =>
		typeof value === 'string' &&
		/^\d{4}-\d{2}-\d{2}$/.test(value) &&
		Number.isFinite(dayNumber(value)) &&
		dateString(dayNumber(value)) === value;
	return p.preset === '' && valid(p.dateStart) && valid(p.dateEnd) && p.dateStart <= p.dateEnd
		? { preset: '', dateStart: p.dateStart, dateEnd: p.dateEnd }
		: fallback;
}
