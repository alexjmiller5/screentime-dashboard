// SEGB v2 parser (the Biome stream segment format on iOS/macOS).
// Port of ccl-segb's ccl_segb2.py, verified record-for-record against it via
// the committed fixture (scripts/make-segb-fixture.py). v2 only - every
// segment in the screentime-backup snapshots carries the v2 "SEGB" magic.

const HEADER_LENGTH = 32;
const ENTRY_HEADER_LENGTH = 8;
const TRAILER_ENTRY_LENGTH = 16;
const COCOA_EPOCH_S = 978307200;

export interface SegbRecord {
	/** Trailer (creation) timestamp, ms since Unix epoch. */
	timestampMs: number;
	/** 1 = written, 3 = deleted (data still readable). */
	state: number;
	crcPassed: boolean;
	data: Uint8Array;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c;
});

function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function cocoaToMs(seconds: number): number {
	return Math.round((COCOA_EPOCH_S + seconds) * 1000);
}

export function parseSegb(bytes: Uint8Array): SegbRecord[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (
		bytes.length < HEADER_LENGTH ||
		String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'SEGB'
	) {
		throw new Error('Not a SEGB v2 file (missing SEGB magic)');
	}
	const entriesCount = view.getInt32(4, true);

	// Trailer sits at the end of the file: one 16-byte entry per record.
	const trailer: { endOffset: number; state: number; timestampMs: number }[] = [];
	let trailerOffset = bytes.length - TRAILER_ENTRY_LENGTH * entriesCount;
	for (let i = 0; i < entriesCount; i++, trailerOffset += TRAILER_ENTRY_LENGTH) {
		const state = view.getInt32(trailerOffset + 4, true);
		if (state !== 1 && state !== 3 && state !== 4) continue; // zeroed/unused slot
		trailer.push({
			endOffset: view.getInt32(trailerOffset, true),
			state,
			timestampMs: cocoaToMs(view.getFloat64(trailerOffset + 8, true))
		});
	}
	trailer.sort((a, b) => a.endOffset - b.endOffset);

	const records: SegbRecord[] = [];
	let cursor = HEADER_LENGTH;
	let previous: { endOffset: number; record: SegbRecord } | null = null;
	for (const entry of trailer) {
		if (entry.state === 4) continue; // empty record, no data region

		// A written record later marked deleted leaves two trailer entries
		// sharing one end offset - same data, different metadata.
		if (previous !== null && entry.endOffset === previous.endOffset) {
			records.push({ ...previous.record, timestampMs: entry.timestampMs, state: entry.state });
			continue;
		}

		const entryLength = entry.endOffset + HEADER_LENGTH - cursor;
		if (entryLength < ENTRY_HEADER_LENGTH) continue; // stale entry, data reused

		const storedCrc = view.getUint32(cursor, true);
		const data = bytes.subarray(cursor + ENTRY_HEADER_LENGTH, cursor + entryLength);
		cursor += entryLength;
		if (entry.endOffset % 4 !== 0) cursor += 4 - (entry.endOffset % 4); // 4-byte alignment

		const record: SegbRecord = {
			timestampMs: entry.timestampMs,
			state: entry.state,
			crcPassed: storedCrc === crc32(data),
			data
		};
		records.push(record);
		previous = { endOffset: entry.endOffset, record };
	}
	return records;
}
