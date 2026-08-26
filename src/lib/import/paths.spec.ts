import { describe, expect, it } from 'vitest';
import { isSnapshotDirName, classifyStreamFile } from './paths';

describe('isSnapshotDirName', () => {
	it('accepts date-named snapshot dirs, with or without suffixes', () => {
		expect(isSnapshotDirName('2026-08-23')).toBe(true);
		expect(isSnapshotDirName('2026-07-05-0008')).toBe(true);
		expect(isSnapshotDirName('2026-07-13-macbook-seed')).toBe(true);
	});
	it('rejects non-snapshot entries', () => {
		expect(isSnapshotDirName('.DS_Store')).toBe(false);
		expect(isSnapshotDirName('notes')).toBe(false);
	});
});

describe('classifyStreamFile', () => {
	it('extracts the device uuid from remote App.InFocus segments', () => {
		expect(
			classifyStreamFile('App.InFocus/remote/AAAAAAAA-1111-2222-3333-444444444444/800000000000001')
		).toEqual({ kind: 'infocus-remote', device: 'AAAAAAAA-1111-2222-3333-444444444444' });
	});

	it('skips tombstone segments (deletion bookkeeping, not usage)', () => {
		expect(
			classifyStreamFile(
				'App.InFocus/remote/AAAAAAAA-1111-2222-3333-444444444444/tombstone/800000000000000'
			)
		).toBeNull();
	});

	it('skips local segments and other streams', () => {
		expect(classifyStreamFile('App.InFocus/local/800000000000002')).toBeNull();
		expect(classifyStreamFile('Media.NowPlaying/remote/AAAA/800000000000003')).toBeNull();
	});
});
