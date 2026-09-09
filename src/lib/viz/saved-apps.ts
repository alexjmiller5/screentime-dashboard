export function readSavedApps(saved: unknown, picked: unknown): string[] {
	const valid = (value: unknown): value is string[] =>
		Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
	return [...new Set(valid(saved) ? saved : valid(picked) ? picked : [])];
}

export function isSavedAppsActive(
	picked: string[],
	saved: string[],
	excludedDevices: string[],
	bucket: string
): boolean {
	return (
		saved.length > 0 &&
		picked.length === saved.length &&
		saved.every((app) => picked.includes(app)) &&
		excludedDevices.length === 0 &&
		bucket === 'day'
	);
}
