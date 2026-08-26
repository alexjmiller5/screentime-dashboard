// Minimal binary plist (bplist00) reader - enough for DeviceActivity
// ActivitySegments (dicts, arrays, strings, ints, reals, bools; plus data,
// dates, and UTF-16 strings for completeness). Verified against a
// plistlib-written fixture.

const MAGIC = 'bplist00';

export type PlistValue =
	null | boolean | number | string | Uint8Array | PlistValue[] | { [key: string]: PlistValue };

export function parseBplist(bytes: Uint8Array): PlistValue {
	const magic = new TextDecoder().decode(bytes.subarray(0, 8));
	if (!magic.startsWith('bplist')) throw new Error('not a bplist (missing bplist00 magic)');

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// 32-byte trailer at the end of the file
	const trailer = bytes.length - 32;
	const offsetSize = bytes[trailer + 6];
	const objectRefSize = bytes[trailer + 7];
	const numObjects = Number(view.getBigUint64(trailer + 8));
	const topObject = Number(view.getBigUint64(trailer + 16));
	const offsetTableStart = Number(view.getBigUint64(trailer + 24));

	const readSizedInt = (offset: number, size: number): number => {
		let value = 0;
		for (let i = 0; i < size; i++) value = value * 256 + bytes[offset + i];
		return value;
	};

	const offsets: number[] = [];
	for (let i = 0; i < numObjects; i++) {
		offsets.push(readSizedInt(offsetTableStart + i * offsetSize, offsetSize));
	}

	/** Object headers pack type in the high nibble and a count in the low one;
	 * count 0xF means a following int object holds the real count. */
	const readLength = (offset: number, low: number): { length: number; next: number } => {
		if (low !== 0xf) return { length: low, next: offset };
		const marker = bytes[offset];
		const intSize = 1 << (marker & 0xf);
		return { length: readSizedInt(offset + 1, intSize), next: offset + 1 + intSize };
	};

	const parseObject = (index: number): PlistValue => {
		const offset = offsets[index];
		const marker = bytes[offset];
		const type = marker >> 4;
		const low = marker & 0xf;
		switch (type) {
			case 0x0: // null / bool
				if (low === 0x8) return false;
				if (low === 0x9) return true;
				return null;
			case 0x1: {
				// int, 2^low bytes big-endian; 8-byte ints are signed
				const size = 1 << low;
				if (size === 8) return Number(view.getBigInt64(offset + 1));
				return readSizedInt(offset + 1, size);
			}
			case 0x2: // real
				return low === 2 ? view.getFloat32(offset + 1) : view.getFloat64(offset + 1);
			case 0x3: // date: float64 seconds since 2001-01-01, as ms epoch number
				return Math.round((view.getFloat64(offset + 1) + 978307200) * 1000);
			case 0x4: {
				// data
				const { length, next } = readLength(offset + 1, low);
				return bytes.subarray(next, next + length);
			}
			case 0x5: {
				// ascii string
				const { length, next } = readLength(offset + 1, low);
				return new TextDecoder('ascii').decode(bytes.subarray(next, next + length));
			}
			case 0x6: {
				// utf-16be string (length in characters)
				const { length, next } = readLength(offset + 1, low);
				return new TextDecoder('utf-16be').decode(bytes.subarray(next, next + length * 2));
			}
			case 0x8: // uid (keyed-archiver refs; surface as number)
				return readSizedInt(offset + 1, low + 1);
			case 0xa: {
				// array
				const { length, next } = readLength(offset + 1, low);
				const out: PlistValue[] = [];
				for (let i = 0; i < length; i++) {
					out.push(parseObject(readSizedInt(next + i * objectRefSize, objectRefSize)));
				}
				return out;
			}
			case 0xd: {
				// dict: N key refs then N value refs
				const { length, next } = readLength(offset + 1, low);
				const out: { [key: string]: PlistValue } = {};
				for (let i = 0; i < length; i++) {
					const key = parseObject(readSizedInt(next + i * objectRefSize, objectRefSize));
					const value = parseObject(
						readSizedInt(next + (length + i) * objectRefSize, objectRefSize)
					);
					out[String(key)] = value;
				}
				return out;
			}
			default:
				throw new Error(`unsupported bplist object type 0x${type.toString(16)}`);
		}
	};

	return parseObject(topObject);
}
