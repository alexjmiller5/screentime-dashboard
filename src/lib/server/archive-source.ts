import { parseArchiveManifest, type ArchiveManifest } from '../import/archive';
import { sha256 } from './archive';
export interface ArchiveHeadStore {
	get(): Promise<string | null>;
	swap(expected: string | null, next: string): Promise<boolean>;
}
interface Transport {
	read(key: string, limit?: number): Promise<ArrayBuffer>;
	create(key: string, bytes: ArrayBuffer): Promise<void>;
}
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export class ArchiveSource {
	constructor(
		private state: ArchiveHeadStore,
		private archive: Transport,
		private prefix: string
	) {}
	private async load(head: string | null): Promise<ArchiveManifest> {
		if (head === null) return { version: 1, files: [] };
		const ref = JSON.parse(head);
		if (
			typeof ref.key !== 'string' ||
			typeof ref.sha256 !== 'string' ||
			!ref.key.startsWith(this.prefix + 'manifests/') ||
			!/^[a-f0-9]{64}$/.test(ref.sha256)
		)
			throw new Error('Invalid archive manifest reference');
		const bytes = await this.archive.read(ref.key, MAX_MANIFEST_BYTES);
		if ((await sha256(bytes)) !== ref.sha256) throw new Error('Archive manifest checksum mismatch');
		const manifest = parseArchiveManifest(
			JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
		);
		if (manifest.files.some((file) => !file.key.startsWith(this.prefix + 'originals/')))
			throw new Error('Archive file outside this project');
		return manifest;
	}
	async manifest() {
		return this.load(await this.state.get());
	}
	async file(path: string) {
		const file = (await this.manifest()).files.find((file) => file.path === path);
		if (!file) throw new Error('Source file is not archived');
		const bytes = await this.archive.read(file.key);
		if (bytes.byteLength !== file.bytes || (await sha256(bytes)) !== file.sha256)
			throw new Error('Archived source checksum mismatch');
		return bytes;
	}
	async put(path: string, bytes: ArrayBuffer, expectedHash: string | null) {
		const digest = await sha256(bytes);
		const [folder, name] = path.split('/');
		const row = {
			path,
			key: `${this.prefix}originals/${folder}/${digest}-${name}`,
			sha256: digest,
			bytes: bytes.byteLength
		};
		parseArchiveManifest({ version: 1, files: [row] });
		if (expectedHash !== null && !/^[a-f0-9]{64}$/.test(expectedHash))
			throw new Error('Invalid expected archive hash');
		let retained = false;
		for (let attempt = 0; attempt < 3; attempt++) {
			const head = await this.state.get();
			const current = await this.load(head);
			const prior = current.files.find((file) => file.path === path);
			if (prior?.sha256 === digest && prior.bytes === bytes.byteLength) return;
			if ((prior?.sha256 ?? null) !== expectedHash)
				throw new Error('Archived source changed; reload before replacing it');
			if (!retained) {
				await this.archive.create(row.key, bytes);
				retained = true;
			}
			const files = [...current.files.filter((file) => file.path !== path), row].sort((a, b) =>
				a.path.localeCompare(b.path)
			);
			const body = new TextEncoder().encode(
				JSON.stringify({ version: 1, files, previous: head === null ? null : JSON.parse(head) })
			).buffer;
			if (body.byteLength > MAX_MANIFEST_BYTES)
				throw new Error('Archive manifest exceeds supported size');
			const hash = await sha256(body);
			const key = `${this.prefix}manifests/${hash}.json`;
			await this.archive.create(key, body);
			if (await this.state.swap(head, JSON.stringify({ key, sha256: hash }))) return;
		}
		throw new Error('Archive changed repeatedly; retry with fresh state');
	}
}
export function archiveHeadStore(db: D1Database): ArchiveHeadStore {
	return {
		async get() {
			return (
				(
					await db
						.prepare("SELECT value FROM meta WHERE key='archive_head'")
						.first<{ value: string }>()
				)?.value ?? null
			);
		},
		async swap(expected, next) {
			const result =
				expected === null
					? await db
							.prepare("INSERT OR IGNORE INTO meta (key,value) VALUES ('archive_head',?)")
							.bind(next)
							.run()
					: await db
							.prepare("UPDATE meta SET value=? WHERE key='archive_head' AND value=?")
							.bind(next, expected)
							.run();
			return result.meta.changes === 1;
		}
	};
}
