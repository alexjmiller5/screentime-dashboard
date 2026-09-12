const TOKEN_RE = /^st_[0-9a-f]{64}$/;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface UploadDevice {
	hash: string;
	label: string;
	created_at: string;
	revoked_at: string | null;
}

export async function hashDeviceToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function validDeviceFingerprint(value: unknown): value is string {
	return typeof value === 'string' && FINGERPRINT_RE.test(value);
}

export function validDeviceLabel(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.trim().length > 0 &&
		value.trim().length <= 100 &&
		!CONTROL_RE.test(value)
	);
}

/** Cloudflare Access remains the owner authentication layer. Header presence
 * only fails closed if /connect is accidentally reached without that edge;
 * it is deliberately not represented as local JWT verification. */
export function hasOwnerAccess(request: Request, url: URL): boolean {
	if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
		return true;
	return Boolean(request.headers.get('Cf-Access-Jwt-Assertion')?.trim());
}

export async function authenticateUploadDevice(
	db: D1Database,
	request: Request
): Promise<UploadDevice | null> {
	const authorization = request.headers.get('Authorization') ?? '';
	const match = /^Bearer (.+)$/i.exec(authorization);
	if (!match || !TOKEN_RE.test(match[1])) return null;
	const hash = await hashDeviceToken(match[1]);
	return db
		.prepare(
			'SELECT hash, label, created_at, revoked_at FROM upload_devices WHERE hash = ? AND revoked_at IS NULL'
		)
		.bind(hash)
		.first<UploadDevice>();
}

export async function approveUploadDevice(
	db: D1Database,
	hash: string,
	label: string
): Promise<boolean> {
	const row = await db
		.prepare(
			`INSERT INTO upload_devices (hash, label) VALUES (?, ?)
ON CONFLICT(hash) DO UPDATE SET label = excluded.label
WHERE upload_devices.revoked_at IS NULL
RETURNING hash`
		)
		.bind(hash, label.trim())
		.first<{ hash: string }>();
	return Boolean(row);
}

export async function listUploadDevices(db: D1Database): Promise<UploadDevice[]> {
	const { results } = await db
		.prepare(
			'SELECT hash, label, created_at, revoked_at FROM upload_devices ORDER BY created_at DESC, hash'
		)
		.all<UploadDevice>();
	return results ?? [];
}

export async function revokeUploadDevice(db: D1Database, hash: string): Promise<boolean> {
	const row = await db
		.prepare(
			`UPDATE upload_devices
SET revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE hash = ?
RETURNING hash`
		)
		.bind(hash)
		.first<{ hash: string }>();
	return Boolean(row);
}

export async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
	const length = Number(request.headers.get('Content-Length'));
	if (Number.isFinite(length) && length > maxBytes) return null;
	const reader = request.body?.getReader();
	if (!reader) return '';
	const decoder = new TextDecoder('utf-8', { fatal: true });
	let bytes = 0;
	let text = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				await reader.cancel();
				return null;
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		return text;
	} catch {
		return null;
	} finally {
		reader.releaseLock();
	}
}
