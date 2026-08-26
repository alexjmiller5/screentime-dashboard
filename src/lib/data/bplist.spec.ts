import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBplist } from './bplist';

const bytes = new Uint8Array(readFileSync(new URL('./fixtures/segment.bplist', import.meta.url)));
const expected = JSON.parse(
	readFileSync(new URL('./fixtures/segment-expected.json', import.meta.url), 'utf8')
);

describe('parseBplist', () => {
	it('round-trips the plistlib-written fixture exactly', () => {
		expect(parseBplist(bytes)).toEqual(expected);
	});

	it('rejects non-bplist data', () => {
		expect(() => parseBplist(new TextEncoder().encode('<?xml version="1.0"?>'))).toThrow(/bplist/);
	});
});
