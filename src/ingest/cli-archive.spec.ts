import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
it('the CLI rebuilds from retained bytes and archives a warm local ledger before skipping it', async () => {
	const root = await mkdtemp(join(tmpdir(), 'archive-cli-test-'));
	const data = await readFile(new URL('../lib/data/fixtures/streams.tar.gz', import.meta.url));
	const hash = createHash('sha256').update(data).digest('hex');
	const path = '2030-01-01/biome-streams.tar.gz';
	const record = { path, key: path, sha256: hash, bytes: data.length };
	let archived = true;
	let archiveWrites = 0,
		sourceReads = 0,
		begins = 0;
	let ledger: unknown[] = [];
	let pending: unknown;
	const body = async (req: import('node:http').IncomingMessage) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		return Buffer.concat(chunks);
	};
	const server = createServer(async (req, res) => {
		const url = new URL(req.url!, 'http://fixture');
		res.setHeader('content-type', 'application/json');
		if (url.pathname === '/api/device/archive') {
			if (req.method === 'POST') {
				expect(await body(req)).toEqual(data);
				expect(req.headers['x-archive-expected']).toBe('new');
				archived = true;
				archiveWrites++;
				res.writeHead(204).end();
				return;
			}
			if (url.searchParams.has('file')) {
				sourceReads++;
				res.end(data);
				return;
			}
			res.end(JSON.stringify({ enabled: true, version: 1, files: archived ? [record] : [] }));
			return;
		}
		if (url.pathname === '/api/device/imports') {
			if (req.method === 'GET') {
				res.end(JSON.stringify({ files: ledger, timeZone: 'UTC' }));
				return;
			}
			const b = JSON.parse((await body(req)).toString());
			if (b.action === 'begin') {
				begins++;
				pending = b;
				res.end(JSON.stringify({ uploadId: 'fixture' }));
				return;
			}
			if (b.action === 'complete') ledger = [pending];
			res.writeHead(204).end();
			return;
		}
		if (url.pathname === '/api/device/ingest') {
			res.writeHead(204).end();
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	try {
		const address = server.address();
		if (!address || typeof address === 'string') throw Error('Missing port');
		const env = {
			...process.env,
			SCREENTIME_DASHBOARD_URL: `http://127.0.0.1:${address.port}`,
			SCREENTIME_DASHBOARD_TOKEN: 'st_' + '0'.repeat(64),
			SCREENTIME_BACKUPS_DIR: join(root, 'backups'),
			SCREENTIME_STATE_DIR: join(root, 'state'),
			SCREENTIME_TIME_ZONE: 'UTC'
		};
		const run = (args: string[] = []) =>
			promisify(execFile)('bun', ['run', 'src/ingest/cli.ts', 'sync', ...args], {
				env,
				timeout: 20000
			});
		expect((await run(['--force'])).stdout).toContain('1 files imported');
		expect(sourceReads).toBe(1);
		expect(begins).toBe(1);
		await mkdir(join(root, 'backups', '2030-01-01'), { recursive: true });
		await writeFile(join(root, 'backups', path), data);
		await run(); // populate the native fingerprint memo
		archived = false;
		expect((await run()).stdout).toContain('0 files imported, 1 already imported');
		expect(archiveWrites).toBe(1);
		expect(begins).toBe(1);
	} finally {
		await new Promise<void>((r) => server.close(() => r()));
		await rm(root, { recursive: true, force: true });
	}
}, 30000);
