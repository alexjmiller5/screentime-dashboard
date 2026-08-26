import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { untar } from './tar';

const tarBytes = new Uint8Array(
	gunzipSync(readFileSync(new URL('./fixtures/streams.tar.gz', import.meta.url)))
);
const segb = new Uint8Array(readFileSync(new URL('./fixtures/infocus.segb', import.meta.url)));
const DEV = 'AAAAAAAA-1111-2222-3333-444444444444';

describe('untar', () => {
	const files = untar(tarBytes);

	it('yields every regular file with its full path and exact bytes', () => {
		expect(files.map((f) => f.name).sort()).toEqual([
			`App.InFocus/local/800000000000002`,
			`App.InFocus/remote/${DEV}/800000000000001`,
			`App.InFocus/remote/${DEV}/tombstone/800000000000000`
		]);
		const segment = files.find((f) => f.name.endsWith('800000000000001'));
		expect(segment && Buffer.from(segment.data).equals(Buffer.from(segb))).toBe(true);
	});

	it('skips directory entries', () => {
		expect(files.some((f) => f.name.endsWith(DEV))).toBe(false);
	});
});
