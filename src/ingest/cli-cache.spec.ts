import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('the installed-interface sync command persists its native memo and honors --force', async () => {
	const root = await mkdtemp(join(tmpdir(), 'screentime-cli-test-'));
	const backups = join(root, 'backups');
	const state = join(root, 'state');
	await mkdir(join(backups, '2026-01-05'), { recursive: true });
	await copyFile(
		new URL('../lib/data/fixtures/streams.tar.gz', import.meta.url),
		join(backups, '2026-01-05', 'biome-streams.tar.gz')
	);
	let ledger: unknown[] = [];
	let pending: unknown;
	let begins = 0;
	const server = createServer(async (req, res) => {
		res.setHeader('content-type', 'application/json');
		if (req.url === '/api/device/imports') {
			if (req.method === 'GET') {
				res.end(JSON.stringify({ files: ledger, timeZone: 'UTC' }));
				return;
			}
			const body = JSON.parse(
				await new Promise<string>((resolve) => {
					let s = '';
					req.on('data', (b) => (s += b));
					req.on('end', () => resolve(s));
				})
			);
			if (body.action === 'begin') {
				pending = body;
				begins++;
				res.end(JSON.stringify({ uploadId: 'test-upload' }));
				return;
			}
			if (body.action === 'complete') ledger = [pending];
		} else if (req.url !== '/api/device/ingest') {
			res.statusCode = 404;
			res.end();
			return;
		}
		res.statusCode = 204;
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		if (!address || typeof address === 'string') throw Error('No test listener');
		const env = {
			...process.env,
			SCREENTIME_DASHBOARD_URL: `http://127.0.0.1:${address.port}`,
			SCREENTIME_DASHBOARD_TOKEN: 'st_' + '0'.repeat(64),
			SCREENTIME_BACKUPS_DIR: backups,
			SCREENTIME_STATE_DIR: state,
			SCREENTIME_TIME_ZONE: 'UTC'
		};
		const run = (args: string[] = []) =>
			promisify(execFile)('bun', ['run', 'src/ingest/cli.ts', 'sync', ...args], {
				env,
				timeout: 15000
			});
		expect((await run()).stdout).toContain('1 files imported, 0 already imported');
		const saved = JSON.parse(await readFile(join(state, 'file-hashes.json'), 'utf8'));
		expect(saved.files).toHaveLength(1);
		expect(saved.files[0][1].hash).toMatch(/^[a-f0-9]{64}$/);
		expect((await run()).stdout).toContain('0 files imported, 1 already imported');
		expect(begins).toBe(1);
		expect((await run(['--force'])).stdout).toContain('1 files imported, 0 already imported');
		expect(begins).toBe(2);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve()))
		);
		await rm(root, { recursive: true, force: true });
	}
}, 20000);
