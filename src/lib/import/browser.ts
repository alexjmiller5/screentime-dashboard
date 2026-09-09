import type { DirLike, FileLike, ImportOptions } from './importer';

/** webkitdirectory includes the selected root in every relative path. */
export function filesToDir(files: FileList | readonly File[]): DirLike {
	const children = new Map<string, Map<string, FileLike>>();
	for (const file of Array.from(files)) {
		const parts = file.webkitRelativePath.split('/');
		if (parts.length !== 3) continue;
		const [, snapshot, name] = parts;
		let entries = children.get(snapshot);
		if (!entries) {
			entries = new Map();
			children.set(snapshot, entries);
		}
		entries.set(name, { kind: 'file', name, getFile: async () => file });
	}
	return {
		async *values() {
			for (const [name, entries] of children)
				yield {
					kind: 'directory' as const,
					name,
					async *values() {
						yield* entries.values();
					}
				};
		}
	};
}

/** Loaded only when a SQLite snapshot actually needs parsing. */
export const querySqlite: ImportOptions['querySqlite'] = async (bytes, sql) => {
	const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
		import('sql.js'),
		import('sql.js/dist/sql-wasm.wasm?url')
	]);
	const SQL = await initSqlJs({ locateFile: () => wasmUrl });
	const db = new SQL.Database(bytes);
	try {
		return db.exec(sql)[0]?.values ?? [];
	} finally {
		db.close();
	}
};
