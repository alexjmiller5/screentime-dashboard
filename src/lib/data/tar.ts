// Minimal ustar reader - enough for biome-streams.tar.gz (regular files +
// directories, ustar prefix field). No symlinks, no pax/gnu long names.

export interface TarFile {
	name: string;
	data: Uint8Array;
}

const BLOCK = 512;

function str(bytes: Uint8Array, offset: number, length: number): string {
	const end = bytes.indexOf(0, offset);
	const stop = end === -1 || end > offset + length ? offset + length : end;
	return new TextDecoder().decode(bytes.subarray(offset, stop));
}

function octal(bytes: Uint8Array, offset: number, length: number): number {
	const text = str(bytes, offset, length).trim();
	return text === '' ? 0 : parseInt(text, 8);
}

export function untar(bytes: Uint8Array): TarFile[] {
	const files: TarFile[] = [];
	let offset = 0;
	while (offset + BLOCK <= bytes.length) {
		const header = bytes.subarray(offset, offset + BLOCK);
		if (header.every((b) => b === 0)) break; // end-of-archive zero block

		let name = str(header, 0, 100);
		const prefix = str(header, 345, 155);
		if (prefix) name = `${prefix}/${name}`;
		const size = octal(header, 124, 12);
		const typeflag = String.fromCharCode(header[156]);

		offset += BLOCK;
		if (typeflag === '0' || typeflag === '\0') {
			files.push({ name, data: bytes.subarray(offset, offset + size) });
		}
		offset += Math.ceil(size / BLOCK) * BLOCK;
	}
	return files;
}
