/// <reference types="bun" />
import { hostname } from 'node:os';
import type { Credential } from './client';
import type { FetchFn } from '../lib/import/incremental';

const SERVICE = 'screentime-ingest';
const validToken = (token: unknown): token is string =>
	typeof token === 'string' && /^st_[a-f0-9]{64}$/.test(token);
const key = (url: string) => ({ service: SERVICE, name: dashboardUrl(url) });

export function dashboardUrl(value: string): string {
	const url = new URL(value);
	if (url.username || url.password) throw new Error('Dashboard URL must not contain credentials');
	if (
		url.protocol !== 'https:' &&
		!(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
	)
		throw new Error('Dashboard URL must use HTTPS');
	if (url.pathname !== '/' || url.search || url.hash)
		throw new Error('Use the dashboard origin without a path, query or fragment');
	return url.origin;
}

export async function credential(env: NodeJS.ProcessEnv = process.env): Promise<Credential> {
	const url = dashboardUrl(env.SCREENTIME_DASHBOARD_URL ?? '');
	let result: Credential;
	if (env.SCREENTIME_DASHBOARD_TOKEN) result = { token: env.SCREENTIME_DASHBOARD_TOKEN };
	else if (env.SCREENTIME_DASHBOARD_CLIENT_ID && env.SCREENTIME_DASHBOARD_CLIENT_SECRET)
		result = {
			clientId: env.SCREENTIME_DASHBOARD_CLIENT_ID,
			clientSecret: env.SCREENTIME_DASHBOARD_CLIENT_SECRET
		};
	else if (env.SCREENTIME_DASHBOARD_CREDENTIAL_COMMAND) {
		const proc = Bun.spawn(['/bin/sh', '-c', env.SCREENTIME_DASHBOARD_CREDENTIAL_COMMAND], {
			stdout: 'pipe',
			stderr: 'inherit'
		});
		const out = await new Response(proc.stdout).text();
		if ((await proc.exited) !== 0) throw new Error('credential command failed');
		result = JSON.parse(out);
	} else {
		const token = await Bun.secrets.get(key(url));
		if (!token) throw new Error('Not signed in. Run screentime-ingest login.');
		result = { token };
	}
	if (
		!result ||
		typeof result !== 'object' ||
		('token' in result
			? !validToken(result.token)
			: typeof result.clientId !== 'string' ||
				!result.clientId ||
				typeof result.clientSecret !== 'string' ||
				!result.clientSecret)
	)
		throw new Error('Invalid dashboard credential');
	if (env.SCREENTIME_DASHBOARD_HEADERS)
		result.headers = JSON.parse(env.SCREENTIME_DASHBOARD_HEADERS);
	if (
		result.headers !== undefined &&
		(!result.headers ||
			typeof result.headers !== 'object' ||
			Array.isArray(result.headers) ||
			Object.values(result.headers).some((v) => typeof v !== 'string'))
	)
		throw new Error('Dashboard headers must be a JSON object of strings');
	return result;
}

async function session(
	url: string,
	token: string,
	fetchFn: FetchFn,
	method = 'GET'
): Promise<Response> {
	const response = await fetchFn(`${dashboardUrl(url)}/api/device/session`, {
		method,
		headers: { Authorization: `Bearer ${token}` },
		redirect: 'error',
		signal: AbortSignal.timeout(15_000)
	});
	if (method === 'GET' && response.ok) {
		const body = await response
			.clone()
			.json()
			.catch(() => null);
		if (!body || typeof body !== 'object' || !('scope' in body) || body.scope !== 'ingest')
			throw new Error('Dashboard returned an invalid device scope');
	}
	return response;
}

export async function login(
	url: string,
	name = hostname(),
	options: { open?: (url: string) => unknown; fetchFn?: FetchFn; noBrowser?: boolean } = {}
): Promise<void> {
	url = dashboardUrl(url);
	name = name.trim();
	if (!name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name))
		throw new Error('Device name must be 1-100 printable characters');
	const fetchFn = options.fetchFn ?? fetch;
	const previous = await Bun.secrets.get(key(url));
	if (previous) {
		const response = await session(url, previous, fetchFn);
		if (response.ok) {
			console.log('Already signed in.');
			return;
		}
		if (response.status !== 401)
			throw new Error(`Could not check sign-in (HTTP ${response.status})`);
	}
	const token = `st_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`;
	const fingerprint = Buffer.from(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
	).toString('hex');
	const approval = new URL('/connect', url);
	approval.searchParams.set('key', fingerprint);
	approval.searchParams.set('name', name);
	console.log(`Approve this upload device: ${approval}`);
	console.log(`Check that the approval code is ${fingerprint.slice(0, 8)}.`);
	if (!options.noBrowser) {
		if (options.open) await options.open(approval.toString());
		else {
			const proc = Bun.spawn(
				[process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', approval.toString()],
				{ stdout: 'ignore', stderr: 'inherit' }
			);
			if ((await proc.exited) !== 0)
				throw new Error('Could not open the browser. Use login --no-browser.');
		}
	}
	const deadline = Date.now() + 10 * 60_000;
	for (;;) {
		const response = await session(url, token, fetchFn);
		if (response.ok) break;
		if (response.status !== 401)
			throw new Error(`Could not check approval (HTTP ${response.status})`);
		if (Date.now() >= deadline)
			throw new Error(
				'Sign-in timed out. Revoke this request in Upload devices if you approved it after leaving.'
			);
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	try {
		if ((await Bun.secrets.get(key(url))) !== previous)
			throw new Error('Sign-in changed in another process; retry.');
		await Bun.secrets.set({ ...key(url), value: token });
	} catch (error) {
		const revoked = await session(url, token, fetchFn, 'DELETE').catch(() => null);
		if (!revoked?.ok)
			throw new Error('Could not save the credential. Revoke this approval in Upload devices.');
		throw error;
	}
	console.log(
		'Signed in. The upload credential is stored in the operating system credential store.'
	);
}

export async function logout(url: string, fetchFn: FetchFn = fetch): Promise<void> {
	const token = await Bun.secrets.get(key(url));
	if (!token) {
		console.log('Already signed out.');
		return;
	}
	const response = await session(url, token, fetchFn, 'DELETE');
	if (!response.ok && response.status !== 401)
		throw new Error(
			`Could not revoke device (HTTP ${response.status}); local credential preserved`
		);
	await Bun.secrets.delete(key(url));
	console.log('Signed out. This upload credential has been revoked.');
}
