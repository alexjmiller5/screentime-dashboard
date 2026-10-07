import { archiveDirectory, parseArchiveManifest, type ArchiveManifest } from './archive';
import type { FetchFn } from './incremental';
export class ArchiveClient {
	private constructor(
		private endpoint: string,
		private fetchFn: FetchFn,
		private manifest: ArchiveManifest
	) {}
	static async open(baseUrl: string, fetchFn: FetchFn = fetch): Promise<ArchiveClient | null> {
		const endpoint = baseUrl.replace(/\/$/, '') + '/api/archive';
		const response = await fetchFn(endpoint, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) throw new Error('Source archive status could not be read');
		const body: unknown = await response.json();
		if (!body || typeof body !== 'object' || !('enabled' in body))
			throw new Error('Invalid source archive status');
		if (body?.enabled === false) return null;
		if (body?.enabled !== true) throw new Error('Invalid source archive status');
		const manifest = parseArchiveManifest(body);
		if (manifest.files.some((file) => file.key !== file.path))
			throw new Error('Invalid dashboard archive paths');
		return new ArchiveClient(endpoint, fetchFn, manifest);
	}
	has(path: string, hash: string) {
		return this.manifest.files.some((file) => file.path === path && file.sha256 === hash);
	}
	async retain(path: string, bytes: ArrayBuffer, hash: string) {
		if (this.has(path, hash)) return;
		const prior = this.manifest.files.find((file) => file.path === path);
		const response = await this.fetchFn(`${this.endpoint}?file=${encodeURIComponent(path)}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/octet-stream',
				'x-archive-expected': prior?.sha256 ?? 'new'
			},
			body: bytes,
			signal: AbortSignal.timeout(120_000)
		});
		if (response.status !== 204)
			throw new Error(`Original source retention was not confirmed (${response.status})`);
		this.manifest.files = this.manifest.files.filter((file) => file.path !== path);
		this.manifest.files.push({ path, key: path, sha256: hash, bytes: bytes.byteLength });
	}
	directory() {
		return archiveDirectory(this.manifest, async (key) => {
			const response = await this.fetchFn(`${this.endpoint}?file=${encodeURIComponent(key)}`, {
				signal: AbortSignal.timeout(120_000)
			});
			if (!response.ok) throw new Error(`Retained source could not be read (${response.status})`);
			return response.arrayBuffer();
		});
	}
}
