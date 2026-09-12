import type { RequestHandler } from './$types';
import {
	approveUploadDevice,
	hasOwnerAccess,
	listUploadDevices,
	readBoundedText,
	revokeUploadDevice,
	validDeviceFingerprint,
	validDeviceLabel
} from '$lib/server/device-auth';

const MAX_FORM_BYTES = 4096;
const HTML_HEADERS = {
	'Content-Type': 'text/html; charset=utf-8',
	'Cache-Control': 'no-store',
	'Referrer-Policy': 'same-origin',
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'DENY',
	'Content-Security-Policy':
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};

function escapeHtml(value: unknown): string {
	return String(value).replace(
		/[&<>"']/g,
		(character) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
	);
}

function page(title: string, content: string, status = 200): Response {
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} - Screen Time</title><style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{font:16px system-ui,sans-serif;max-width:48rem;margin:0 auto;padding:2rem 1rem;color:CanvasText;background:Canvas}main{border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:12px;padding:clamp(1rem,4vw,2rem)}h1{font-size:1.5rem;margin-top:0}p{line-height:1.5}code{overflow-wrap:anywhere}button{font:inherit;padding:.6rem 1rem;border-radius:8px;border:1px solid ButtonBorder;background:ButtonFace;color:ButtonText;cursor:pointer}a{color:LinkText}.devices{list-style:none;padding:0}.devices li{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;padding:1rem 0;border-top:1px solid color-mix(in srgb,CanvasText 15%,transparent)}.devices small{display:block;margin-top:.4rem}.devices strong{overflow-wrap:anywhere}.actions{display:flex;gap:.75rem;flex-wrap:wrap;align-items:center}</style></head><body><main><p><a href="/">Dashboard</a></p><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`,
		{ status, headers: HTML_HEADERS }
	);
}

function error(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
	});
}

function queryValues(url: URL): { key: string; name: string } | null {
	const pairs = [...url.searchParams.entries()];
	if (
		pairs.length !== 2 ||
		new Set(pairs.map(([key]) => key)).size !== 2 ||
		!url.searchParams.has('key') ||
		!url.searchParams.has('name')
	)
		return null;
	return { key: url.searchParams.get('key')!, name: url.searchParams.get('name')! };
}

async function formValues(request: Request): Promise<URLSearchParams | null | 'large'> {
	if (request.headers.get('Origin') !== new URL(request.url).origin) return null;
	if (
		request.headers.get('Content-Type')?.split(';', 1)[0].trim() !==
		'application/x-www-form-urlencoded'
	)
		return null;
	const text = await readBoundedText(request, MAX_FORM_BYTES);
	if (text === null) return 'large';
	return new URLSearchParams(text);
}

function exactFields(params: URLSearchParams, names: string[]): boolean {
	const pairs = [...params.entries()];
	return (
		pairs.length === names.length &&
		new Set(pairs.map(([key]) => key)).size === names.length &&
		pairs.every(([key]) => names.includes(key))
	);
}

async function devicesPage(db: D1Database): Promise<Response> {
	const rows = (await listUploadDevices(db))
		.map(
			(device) =>
				`<li><div><strong>${escapeHtml(device.label)}</strong><small>${device.revoked_at ? 'Revoked' : 'Active'} · Approved ${escapeHtml(device.created_at.slice(0, 10))}</small><small>Approval code: <code>${device.hash.slice(0, 8)}</code></small></div>${
					device.revoked_at
						? ''
						: `<form method="post" action="/connect"><input type="hidden" name="action" value="revoke"><input type="hidden" name="key" value="${device.hash}"><button type="submit">Revoke</button></form>`
				}</li>`
		)
		.join('');
	return page(
		'Screen Time upload devices',
		`<p>These devices can upload import files and report refresh progress. They cannot view usage, edit markers, manage other upload devices, or create refresh jobs. Browser access remains separate.</p><ul class="devices">${rows || '<li>No upload devices</li>'}</ul>`
	);
}

export const GET: RequestHandler = async ({ platform, request, url }) => {
	if (!hasOwnerAccess(request, url)) return error('Cloudflare Access login required', 403);
	if (url.searchParams.size === 0) return devicesPage(platform!.env.DB);
	const values = queryValues(url);
	if (!values || !validDeviceFingerprint(values.key) || !validDeviceLabel(values.name))
		return error('Invalid device approval link', 400);
	return page(
		'Approve Screen Time upload device',
		`<p>Approve <strong>${escapeHtml(values.name.trim())}</strong> to upload Screen Time import files and report refresh progress.</p><p>Approval code: <code>${values.key.slice(0, 8)}</code></p><p>Approve only while the CLI is waiting, and only if this code matches the code shown by the CLI.</p><form method="post" action="/connect"><input type="hidden" name="action" value="approve"><input type="hidden" name="key" value="${values.key}"><input type="hidden" name="name" value="${escapeHtml(values.name)}"><div class="actions"><button type="submit">Approve device</button><a href="/connect">Manage devices</a></div></form>`
	);
};

export const POST: RequestHandler = async ({ platform, request, url }) => {
	if (!hasOwnerAccess(request, url)) return error('Cloudflare Access login required', 403);
	if (request.headers.get('Origin') !== url.origin)
		return error('Same-origin form submission required', 403);
	const form = await formValues(request);
	if (form === 'large') return error('Form too large', 413);
	if (!form) return error('Invalid form submission', 400);
	const action = form.get('action');
	if (action === 'approve') {
		if (
			!exactFields(form, ['action', 'key', 'name']) ||
			!validDeviceFingerprint(form.get('key')) ||
			!validDeviceLabel(form.get('name'))
		)
			return error('Invalid device approval', 400);
		const approved = await approveUploadDevice(
			platform!.env.DB,
			form.get('key')!,
			form.get('name')!
		);
		if (!approved)
			return page(
				'Screen Time upload token already revoked',
				'<p>This upload token was revoked and cannot be reused. Start a new CLI enrollment.</p><p><a href="/connect">Manage devices</a></p>',
				409
			);
		return page(
			'Screen Time upload device approved',
			'<p>If the CLI is still waiting, enrollment will finish automatically.</p><p><a href="/connect">Manage devices</a></p>'
		);
	}
	if (action === 'revoke') {
		if (!exactFields(form, ['action', 'key']) || !validDeviceFingerprint(form.get('key')))
			return error('Invalid device', 400);
		if (!(await revokeUploadDevice(platform!.env.DB, form.get('key')!)))
			return error('Device not found', 404);
		return page(
			'Screen Time upload token revoked',
			'<p>This token can no longer upload files or report refresh progress. Browser access is unchanged.</p><p><a href="/connect">Manage devices</a></p>'
		);
	}
	return error('Invalid form submission', 400);
};

export const fallback: RequestHandler = async ({ request, url }) => {
	if (!hasOwnerAccess(request, url)) return error('Cloudflare Access login required', 403);
	return error('Method not allowed', 405);
};
