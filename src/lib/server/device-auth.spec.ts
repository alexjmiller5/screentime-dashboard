import { readFileSync } from 'node:fs';
import initSqlJs, { type Database, type SqlValue } from 'sql.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
	GET as connectGET,
	POST as connectPOST,
	fallback as connectFallback
} from '../../routes/connect/+server';
import {
	DELETE as deviceDELETE,
	GET as deviceGET,
	POST as devicePOST,
	fallback as deviceFallback
} from '../../routes/api/device/[...path]/+server';
import { hashDeviceToken } from './device-auth';

let sqlite: Database;
let db: D1Database;

beforeEach(async () => {
	const SQL = await initSqlJs();
	sqlite = new SQL.Database();
	sqlite.run('PRAGMA foreign_keys = ON');
	for (const name of [
		'0001_init.sql',
		'0002_incremental_imports.sql',
		'0003_markers.sql',
		'0004_upload_devices.sql'
	])
		sqlite.run(readFileSync(`migrations/${name}`, 'utf8'));
	const prepare = (sql: string, params: SqlValue[] = []): unknown => ({
		bind: (...values: SqlValue[]) => prepare(sql, values),
		all: async () => execute(sql, params),
		run: async () => execute(sql, params),
		first: async (column?: string) => {
			const row = execute(sql, params).results[0];
			return column ? (row?.[column] ?? null) : (row ?? null);
		},
		execute: () => execute(sql, params)
	});
	function execute(sql: string, params: SqlValue[]) {
		const statement = sqlite.prepare(sql);
		try {
			statement.bind(params);
			const results: Record<string, SqlValue>[] = [];
			while (statement.step()) results.push(statement.getAsObject());
			return { results, success: true, meta: { changes: sqlite.getRowsModified() } };
		} finally {
			statement.free();
		}
	}
	db = { prepare } as unknown as D1Database;
});

afterEach(() => sqlite.close());

const assertion = { 'Cf-Access-Jwt-Assertion': 'edge-assertion' };
const formHeaders = {
	...assertion,
	Origin: 'https://screen.test',
	'Content-Type': 'application/x-www-form-urlencoded'
};
const token = `st_${'1'.repeat(64)}`;

function connectEvent(path: string, method = 'GET', body?: BodyInit, headers?: HeadersInit) {
	return {
		platform: { env: { DB: db } },
		url: new URL(`https://screen.test${path}`),
		request: new Request(`https://screen.test${path}`, { method, body, headers })
	} as Parameters<typeof connectGET>[0];
}

function deviceEvent(path: string, method = 'GET', bearer?: string, body?: BodyInit) {
	const url = `https://screen.test/api/device/${path}`;
	return {
		platform: { env: { DB: db } },
		params: { path },
		url: new URL(url),
		request: new Request(url, {
			method,
			body,
			headers: bearer
				? { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }
				: undefined
		})
	} as Parameters<typeof deviceGET>[0];
}

async function approve(key: string, name = 'Bedroom Mac') {
	const body = new URLSearchParams({ action: 'approve', key, name }).toString();
	return connectPOST(connectEvent('/connect', 'POST', body, formHeaders));
}

it('keeps connect owner-only in production and renders a non-mutating escaped approval page', async () => {
	const key = 'a'.repeat(64);
	const path = `/connect?key=${key}&name=${encodeURIComponent('Mac <mini>')}`;
	expect((await connectGET(connectEvent(path))).status).toBe(403);
	const response = await connectGET(connectEvent(path, 'GET', undefined, assertion));
	const html = await response.text();
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
	expect(html).toContain('Mac &lt;mini&gt;');
	expect(html).toContain('Approval code');
	expect(html).toContain(key.slice(0, 8));
	expect(html).toContain('only while the CLI is waiting');
	expect(html).toContain('matches the code shown by the CLI');
	expect(
		(await db.prepare('SELECT count(*) AS count FROM upload_devices').first<{ count: number }>())!
			.count
	).toBe(0);
});

it('validates approval links and bounded same-origin form submissions', async () => {
	for (const path of [
		`/connect?key=${'a'.repeat(63)}&name=Mac`,
		`/connect?key=${'a'.repeat(64)}&name=`,
		`/connect?key=${'a'.repeat(64)}&name=Mac&extra=x`
	])
		expect((await connectGET(connectEvent(path, 'GET', undefined, assertion))).status).toBe(400);

	const valid = new URLSearchParams({
		action: 'approve',
		key: 'a'.repeat(64),
		name: 'Mac'
	}).toString();
	expect(
		(
			await connectPOST(
				connectEvent('/connect', 'POST', valid, { ...formHeaders, Origin: 'https://evil.test' })
			)
		).status
	).toBe(403);
	expect(
		(
			await connectPOST(
				connectEvent('/connect', 'POST', JSON.stringify({ key: 'a'.repeat(64), name: 'Mac' }), {
					...assertion,
					Origin: 'https://screen.test',
					'Content-Type': 'application/json'
				})
			)
		).status
	).toBe(400);
	expect((await approve('a'.repeat(64), `Mac${'x'.repeat(100)}`)).status).toBe(400);
	expect(
		(
			await connectPOST(
				connectEvent(
					'/connect',
					'POST',
					`action=approve&key=${'a'.repeat(64)}&name=${'x'.repeat(5000)}`,
					formHeaders
				)
			)
		).status
	).toBe(413);
});

it('keeps unsupported connect methods owner-gated and non-cacheable', async () => {
	const unauthorized = await connectFallback(connectEvent('/connect', 'DELETE'));
	expect(unauthorized.status).toBe(403);
	expect(unauthorized.headers.get('cache-control')).toBe('no-store');
	const unsupported = await connectFallback(
		connectEvent('/connect', 'DELETE', undefined, assertion)
	);
	expect(unsupported.status).toBe(405);
	expect(unsupported.headers.get('cache-control')).toBe('no-store');
});

it('stores only the fingerprint, lists devices, revokes them, and never reactivates a revoked key', async () => {
	const key = await hashDeviceToken(token);
	expect((await approve(key)).status).toBe(200);
	const row = await db
		.prepare('SELECT hash, label, created_at, revoked_at FROM upload_devices')
		.first<{ hash: string; label: string; created_at: string; revoked_at: string | null }>();
	expect(row).toMatchObject({ hash: key, label: 'Bedroom Mac', revoked_at: null });
	expect(JSON.stringify(row)).not.toContain(token);

	const listing = await connectGET(connectEvent('/connect', 'GET', undefined, assertion));
	expect(await listing.text()).toContain('Bedroom Mac');
	const revoke = new URLSearchParams({ action: 'revoke', key }).toString();
	expect((await connectPOST(connectEvent('/connect', 'POST', revoke, formHeaders))).status).toBe(
		200
	);
	expect((await approve(key, 'Reactivated')).status).toBe(409);
	expect(
		await db
			.prepare('SELECT label, revoked_at FROM upload_devices WHERE hash = ?')
			.bind(key)
			.first()
	).toMatchObject({ label: 'Bedroom Mac' });
});

it('requires a valid active bearer token before applying the fixed route and method allowlist', async () => {
	const key = await hashDeviceToken(token);
	await approve(key);
	for (const event of [
		deviceEvent('session'),
		deviceEvent('session', 'GET', 'bad'),
		deviceEvent('session', 'GET', `st_${'g'.repeat(64)}`),
		deviceEvent('session', 'GET', `st_${'2'.repeat(64)}`)
	]) {
		const response = await deviceGET(event);
		expect(response.status).toBe(401);
		expect(response.headers.get('cache-control')).toBe('no-store');
	}
	expect(await (await deviceGET(deviceEvent('session', 'GET', token))).json()).toEqual({
		scope: 'ingest'
	});
	expect((await devicePOST(deviceEvent('usage', 'POST', token, '{}'))).status).toBe(404);
	expect((await devicePOST(deviceEvent('refresh', 'POST', token, '{}'))).status).toBe(405);
	expect((await deviceFallback(deviceEvent('imports', 'PUT', token, '{}'))).status).toBe(405);
});

it('forwards only import and refresh-progress operations and forces no-store responses', async () => {
	const key = await hashDeviceToken(token);
	await approve(key);
	const cases = [
		[deviceGET, deviceEvent('imports', 'GET', token), 200],
		[devicePOST, deviceEvent('imports', 'POST', token, '{}'), 400],
		[devicePOST, deviceEvent('ingest', 'POST', token, JSON.stringify({ runId: 'run' })), 204],
		[deviceGET, deviceEvent('refresh', 'GET', token), 200],
		[devicePOST, deviceEvent('refresh/job', 'POST', token, '{}'), 400]
	] as const;
	for (const [handler, event, status] of cases) {
		const response = await handler(event);
		expect(response.status).toBe(status);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.status < 300 || response.status >= 400).toBe(true);
	}
});

it('lets a device revoke only itself and rejects the token afterward', async () => {
	const key = await hashDeviceToken(token);
	await approve(key);
	const response = await deviceDELETE(deviceEvent('session', 'DELETE', token));
	expect(response.status).toBe(204);
	expect(await response.text()).toBe('');
	expect((await deviceGET(deviceEvent('session', 'GET', token))).status).toBe(401);
});
