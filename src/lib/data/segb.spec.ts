import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSegb } from './segb';

const fixture = new Uint8Array(readFileSync(new URL('./fixtures/infocus.segb', import.meta.url)));
const expected: {
	timestamp: string;
	state: number;
	crcPassed: boolean;
	dataBase64: string;
}[] = JSON.parse(readFileSync(new URL('./fixtures/expected.json', import.meta.url), 'utf8'));

describe('parseSegb', () => {
	it('yields exactly the records the ccl-segb reference implementation yields', () => {
		const records = parseSegb(fixture);
		expect(records).toHaveLength(expected.length);
		for (const [i, exp] of expected.entries()) {
			const rec = records[i];
			expect(rec.timestampMs, `record ${i} timestamp`).toBe(Date.parse(exp.timestamp));
			expect(rec.state, `record ${i} state`).toBe(exp.state);
			expect(rec.crcPassed, `record ${i} crc`).toBe(exp.crcPassed);
			expect(Buffer.from(rec.data).toString('base64'), `record ${i} data`).toBe(exp.dataBase64);
		}
	});

	it('rejects data without the SEGB magic', () => {
		expect(() => parseSegb(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(/SEGB/);
	});
});
