import type { FetchFn } from '../import/incremental';
/** Supported Life Data retained-file API. Only this service's configured prefix is reachable. */
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
export async function sha256(bytes: ArrayBuffer): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
		b.toString(16).padStart(2, '0')
	).join('');
}
export async function boundedBytes(
	response: Response,
	limit = MAX_ARCHIVE_BYTES
): Promise<ArrayBuffer> {
	const reader = response.body?.getReader();
	if (!reader) return new ArrayBuffer(0);
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				await reader.cancel();
				throw new Error('Archive file exceeds supported size');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result.buffer;
}
const validKey = (key: string) =>
	key.length > 0 &&
	key.isWellFormed() &&
	!/[\\\u0000-\u001f\u007f?#%:]/.test(key) &&
	key.split('/').every((p) => !!p && p !== '.' && p !== '..');
export class LifeArchive {
	private base: string;
	constructor(
		base: string,
		private token: string,
		private prefix: string,
		private fetchFn: FetchFn = fetch
	) {
		const url = new URL(base);
		if (
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash ||
			(url.protocol !== 'https:' &&
				!(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
		)
			throw new Error('Archive service must be an HTTPS origin');
		if (!token || !prefix.endsWith('/') || !validKey(prefix.slice(0, -1)))
			throw new Error('Invalid archive configuration');
		this.base = url.origin;
	}
	private request(key: string, init: RequestInit = {}) {
		if (!validKey(key) || !key.startsWith(this.prefix))
			throw new Error('Archive key is outside this project');
		return this.fetchFn(
			`${this.base}/v1/files/${key.split('/').map(encodeURIComponent).join('/')}`,
			{
				...init,
				headers: {
					...init.headers,
					Authorization: `Bearer ${this.token}`,
					'User-Agent': 'screentime-dashboard/1.0'
				},
				redirect: 'manual',
				signal: AbortSignal.timeout(120_000)
			}
		);
	}
	async read(key: string, limit = MAX_ARCHIVE_BYTES): Promise<ArrayBuffer> {
		const response = await this.request(key);
		if (!response.ok || response.redirected)
			throw new Error(`Archive read failed (${response.status})`);
		return boundedBytes(response, limit);
	}
	async create(key: string, bytes: ArrayBuffer): Promise<void> {
		if (bytes.byteLength > MAX_ARCHIVE_BYTES)
			throw new Error('Archive file exceeds supported size');
		const digest = await sha256(bytes);
		const response = await this.request(key, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/octet-stream',
				'If-None-Match': '*',
				'X-Content-SHA256': digest
			},
			body: bytes
		});
		if (response.status === 412) {
			const saved = await this.read(key);
			if (saved.byteLength !== bytes.byteLength || (await sha256(saved)) !== digest)
				throw new Error('Existing archive differs');
			return;
		}
		if (response.status !== 201 || response.redirected)
			throw new Error(`Archive write failed (${response.status})`);
		const receipt = (await response.json()) as { sha256?: string; bytes?: number };
		if (receipt.sha256 !== digest || receipt.bytes !== bytes.byteLength)
			throw new Error('Archive did not verify the stored checksum');
	}
}
