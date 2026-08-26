// App.InFocus payload extraction. Payloads are protobuf messages; the fields
// that matter (verified against real streams with blackboxprotobuf, 2026-08-25):
//   3 (varint)   focus gained (1) / lost (0)
//   4 (fixed64)  event timestamp - an IEEE754 double of Cocoa seconds
//   6 (string)   bundle id
// Everything else (versions, transition reasons, nested extras) is skipped.

import type { SegbRecord } from './segb';

const COCOA_EPOCH_S = 978307200;

export interface FocusEvent {
	tsMs: number;
	bundleId: string;
	focus: boolean;
}

/** Minimal protobuf wire scan of one message's top-level fields. */
function scanFields(data: Uint8Array): Map<number, number | Uint8Array> {
	const fields = new Map<number, number | Uint8Array>();
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let i = 0;
	const varint = (): number => {
		let shift = 0;
		let value = 0;
		for (;;) {
			if (i >= data.length) throw new Error('truncated varint');
			const b = data[i++];
			// Number math is fine: real values here fit in 2^53.
			value += (b & 0x7f) * 2 ** shift;
			if ((b & 0x80) === 0) return value;
			shift += 7;
			if (shift > 63) throw new Error('varint too long');
		}
	};
	while (i < data.length) {
		const tag = varint();
		const fieldNum = Math.floor(tag / 8);
		const wireType = tag & 7;
		if (fieldNum === 0) throw new Error('invalid field number');
		switch (wireType) {
			case 0:
				fields.set(fieldNum, varint());
				break;
			case 1: {
				if (i + 8 > data.length) throw new Error('truncated fixed64');
				fields.set(fieldNum, data.subarray(i, i + 8));
				i += 8;
				break;
			}
			case 2: {
				const len = varint();
				if (i + len > data.length) throw new Error('truncated bytes');
				fields.set(fieldNum, data.subarray(i, i + len));
				i += len;
				break;
			}
			case 5: {
				if (i + 4 > data.length) throw new Error('truncated fixed32');
				fields.set(fieldNum, data.subarray(i, i + 4));
				i += 4;
				break;
			}
			default:
				throw new Error(`unsupported wire type ${wireType}`);
		}
	}
	void view;
	return fields;
}

export function extractFocusEvents(records: SegbRecord[]): FocusEvent[] {
	const events: FocusEvent[] = [];
	for (const record of records) {
		let fields: Map<number, number | Uint8Array>;
		try {
			fields = scanFields(record.data);
		} catch {
			continue; // not a parseable payload
		}
		const focus = fields.get(3);
		const ts = fields.get(4);
		const bundle = fields.get(6);
		if (typeof focus !== 'number' || !(ts instanceof Uint8Array) || !(bundle instanceof Uint8Array))
			continue;
		if (ts.length !== 8) continue;
		const cocoaSeconds = new DataView(ts.buffer, ts.byteOffset, 8).getFloat64(0, true);
		events.push({
			tsMs: Math.round((COCOA_EPOCH_S + cocoaSeconds) * 1000),
			bundleId: new TextDecoder().decode(bundle),
			focus: focus === 1
		});
	}
	return events;
}
