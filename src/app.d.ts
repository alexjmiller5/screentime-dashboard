// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
			caches: CacheStorage;
			cf?: IncomingRequestCfProperties;
		}

		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
	}
}

declare global {
	interface Window {
		/** File System Access API (Chromium) - the import flow requires it. */
		showDirectoryPicker(options?: {
			id?: string;
			mode?: 'read';
		}): Promise<FileSystemDirectoryHandle>;
	}
	interface FileSystemDirectoryHandle {
		values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
	}
}

export {};
