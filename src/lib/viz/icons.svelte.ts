// Reactive icon resolution for app identities. Order: the static brand map
// (selfhst/Tabler via Iconify), site favicons for web domains - both inside
// appIcon() - then the App Store's own artwork via the iTunes lookup API
// (CORS-open), batched per tick and cached in localStorage so the long tail
// of apps resolves once and sticks.

import { appIcon } from './format';

const STORE_KEY = 'screentime:itunes-icons';

let store = $state<Record<string, string>>({}); // raw bundle id -> url, '' = known miss
let loaded = false;
const requested = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

function request(raw: string): void {
	if (requested.has(raw) || raw.startsWith('web:') || !raw.includes('.')) return;
	requested.add(raw);
	timer ??= setTimeout(flush, 50);
}

async function flush(): Promise<void> {
	timer = null;
	const all = [...requested].filter((r) => store[r] === undefined);
	// The lookup API rejects oversized batches - chunk it.
	for (let i = 0; i < all.length; i += 50) {
		const raws = all.slice(i, i + 50);
		// Misses are persisted as '' so they are not re-queried every visit.
		const found: Record<string, string> = Object.fromEntries(raws.map((r) => [r, '']));
		try {
			const res = await fetch(
				`https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(raws.join(','))}&country=us`
			);
			const byLower = new Map(raws.map((r) => [r.toLowerCase(), r]));
			const json = (await res.json()) as {
				results?: { bundleId?: string; artworkUrl60?: string }[];
			};
			for (const r of json.results ?? []) {
				const key = byLower.get(String(r.bundleId).toLowerCase());
				if (key && r.artworkUrl60) found[key] = r.artworkUrl60;
			}
		} catch {
			return; // offline or throttled: leave unresolved, retried next page load
		}
		store = { ...store, ...found };
		localStorage.setItem(STORE_KEY, JSON.stringify(store));
	}
}

/** Icon URL for a display key + its raw bundle id, or null while unknown.
 * Reactive: reads resolve again once a pending iTunes lookup lands. */
export function iconUrl(key: string, raw: string): string | null {
	if (!loaded) {
		loaded = true;
		try {
			store = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, string>;
		} catch {
			/* first run */
		}
	}
	const fixed = appIcon(key);
	if (fixed) return fixed;
	const hit = store[raw];
	if (hit !== undefined) return hit || null;
	request(raw);
	return null;
}
