import { afterEach, describe, expect, it, vi } from 'vitest';
import { credential, dashboardUrl, login, logout } from './auth';

afterEach(() => vi.unstubAllGlobals());

describe('ingest device enrollment', () => {
	it('requires HTTPS outside loopback and reads native auth without a credential supplier', async () => {
		const token = `st_${'a'.repeat(64)}`;
		const get = vi.fn().mockResolvedValue(token);
		vi.stubGlobal('Bun', { secrets: { get } });
		expect(dashboardUrl('https://dash.example/')).toBe('https://dash.example');
		expect(() => dashboardUrl('http://dash.example')).toThrow('HTTPS');
		expect(() => dashboardUrl('https://user:password@dash.example')).toThrow('credentials');
		expect(await credential({ SCREENTIME_DASHBOARD_URL: 'https://dash.example/' })).toEqual({
			token
		});
		expect(get).toHaveBeenCalledWith({
			service: 'screentime-ingest',
			name: 'https://dash.example'
		});
	});

	it('enrolls only the fingerprint, waits for approval, then stores the bearer in native storage', async () => {
		const get = vi.fn().mockResolvedValue(null);
		const set = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('Bun', { secrets: { get, set } });
		const open = vi.fn();
		const fetchFn = vi.fn().mockResolvedValue(Response.json({ scope: 'ingest' }));
		await login('https://dash.example', 'Test uploader', { open, fetchFn });
		const approval = new URL(open.mock.calls[0][0]);
		const saved = set.mock.calls[0][0];
		expect(approval.pathname).toBe('/connect');
		expect(approval.searchParams.get('name')).toBe('Test uploader');
		expect(approval.searchParams.get('key')).toMatch(/^[a-f0-9]{64}$/);
		expect(approval.toString()).not.toContain(saved.value);
		expect(saved.value).toMatch(/^st_[a-f0-9]{64}$/);
		expect(saved).toMatchObject({ service: 'screentime-ingest', name: 'https://dash.example' });
		expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${saved.value}`);
	});

	it('preserves the local credential if revocation fails and removes it after revocation', async () => {
		const token = `st_${'b'.repeat(64)}`;
		const remove = vi.fn().mockResolvedValue(true);
		vi.stubGlobal('Bun', { secrets: { get: vi.fn().mockResolvedValue(token), delete: remove } });
		await expect(
			logout('https://dash.example', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))
		).rejects.toThrow('503');
		expect(remove).not.toHaveBeenCalled();
		const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
		await logout('https://dash.example', fetchFn);
		expect(fetchFn.mock.calls[0][1].method).toBe('DELETE');
		expect(remove).toHaveBeenCalledWith({
			service: 'screentime-ingest',
			name: 'https://dash.example'
		});
	});

	it('rejects a successful response with the wrong scope and revokes approval if native storage fails', async () => {
		const set = vi.fn().mockRejectedValue(new Error('Keychain locked'));
		vi.stubGlobal('Bun', { secrets: { get: vi.fn().mockResolvedValue(null), set } });
		await expect(
			login('https://dash.example', 'Uploader', {
				noBrowser: true,
				fetchFn: vi.fn().mockResolvedValue(Response.json({ scope: 'admin' }))
			})
		).rejects.toThrow('scope');
		expect(set).not.toHaveBeenCalled();
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ scope: 'ingest' }))
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		await expect(
			login('https://dash.example', 'Uploader', { noBrowser: true, fetchFn })
		).rejects.toThrow('Keychain locked');
		expect(fetchFn.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'DELETE']);
	});
});
