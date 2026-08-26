import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { gunzip } from './gunzip';

describe('gunzip', () => {
	it('inflates gzip bytes via DecompressionStream', async () => {
		const gz = new Uint8Array(
			readFileSync(new URL('../data/fixtures/streams.tar.gz', import.meta.url))
		);
		const expected = new Uint8Array(gunzipSync(gz));
		expect(Buffer.from(await gunzip(gz)).equals(Buffer.from(expected))).toBe(true);
	});
});
