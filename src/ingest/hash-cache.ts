import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CachedHash {
	fingerprint: string;
	hash: string;
}
export type HashCache = Map<string, CachedHash>;

/** A local filesystem change identity, never just size/mtime. Coarse change clocks
 * cannot distinguish rapid rewrites, so those files keep the content-hash path. */
export function fileFingerprint(metadata: {
	dev?: unknown;
	ino?: unknown;
	size?: unknown;
	mtimeNs?: unknown;
	ctimeNs?: unknown;
}): string | undefined {
	const { dev, ino, size, mtimeNs, ctimeNs } = metadata;
	if (
		typeof dev !== 'bigint' ||
		dev <= 0n ||
		typeof ino !== 'bigint' ||
		ino <= 0n ||
		typeof size !== 'bigint' ||
		size < 0n ||
		typeof mtimeNs !== 'bigint' ||
		mtimeNs < 0n ||
		typeof ctimeNs !== 'bigint' ||
		ctimeNs <= 0n ||
		ctimeNs % 1_000_000n === 0n
	)
		return;
	return [dev, ino, size, mtimeNs, ctimeNs].join(':');
}

export async function loadHashCache(path: string): Promise<HashCache> {
	try {
		const parsed = JSON.parse(await readFile(path, 'utf8'));
		if (parsed?.version !== 1 || !Array.isArray(parsed.files)) return new Map();
		return new Map(
			parsed.files.filter((entry: unknown): entry is [string, CachedHash] => {
				if (!Array.isArray(entry) || entry.length !== 2) return false;
				const [key, value] = entry;
				return (
					typeof key === 'string' &&
					value &&
					typeof value === 'object' &&
					typeof value.fingerprint === 'string' &&
					/^\d+:\d+:\d+:\d+:\d+$/.test(value.fingerprint) &&
					typeof value.hash === 'string' &&
					/^[a-f0-9]{64}$/.test(value.hash)
				);
			})
		);
	} catch {
		return new Map();
	}
}

export async function saveHashCache(path: string, cache: HashCache): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${crypto.randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify({ version: 1, files: [...cache] }), { mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch(() => {});
	}
}
