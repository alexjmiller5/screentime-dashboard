import { describe, expect, it } from 'vitest';
import {
	isSnapshotDirName,
	classifyStreamFile,
	classifyDeviceActivityFile,
	guessDeviceLabel
} from './paths';
import type { FocusEvent } from '../data/infocus';

const ev = (bundleId: string): FocusEvent => ({ tsMs: 0, bundleId, focus: true });

describe('guessDeviceLabel', () => {
	it('recognizes an iPhone by SpringBoard surfaces', () => {
		expect(
			guessDeviceLabel([
				ev('com.spotify.client'),
				ev('com.apple.SpringBoard.transitionReason.homescreen')
			])
		).toBe('iPhone');
		expect(guessDeviceLabel([ev('com.apple.springboard.today-view')])).toBe('iPhone');
	});

	it('recognizes a Mac by Finder/loginwindow', () => {
		expect(guessDeviceLabel([ev('com.apple.finder'), ev('com.google.Chrome')])).toBe('Mac');
		expect(guessDeviceLabel([ev('com.apple.loginwindow')])).toBe('Mac');
	});

	it('recognizes iOS by .ios-suffixed or com.apple.mobile* bundles', () => {
		expect(guessDeviceLabel([ev('com.google.chrome.ios')])).toBe('iPhone');
		expect(guessDeviceLabel([ev('com.apple.mobilenotes')])).toBe('iPhone');
	});

	it('Mac markers beat weak iOS hints - Messages on the Mac is com.apple.MobileSMS', () => {
		expect(guessDeviceLabel([ev('com.apple.MobileSMS'), ev('com.apple.finder')])).toBe('Mac');
		expect(guessDeviceLabel([ev('com.google.chrome.ios'), ev('com.apple.loginwindow')])).toBe(
			'Mac'
		);
	});

	it('returns null when nothing platform-distinctive is present', () => {
		expect(guessDeviceLabel([ev('com.spotify.client')])).toBeNull();
		expect(guessDeviceLabel([])).toBeNull();
	});
});

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

describe('classifyDeviceActivityFile', () => {
	it('extracts device uuid and day timestamp from Cloud Daily segments', () => {
		expect(
			classifyDeviceActivityFile(
				'com.apple.DeviceActivity/Cloud/000830-08-user/BBBBBBBB-1111-2222-3333-444444444444/Daily/ActivitySegments/809409600.0.plist'
			)
		).toEqual({ device: 'BBBBBBBB-1111-2222-3333-444444444444', cocoaSeconds: 809409600 });
	});

	it('ignores Hourly, Local, and sync-state files', () => {
		expect(
			classifyDeviceActivityFile(
				'com.apple.DeviceActivity/Cloud/u/BBBBBBBB-1111-2222-3333-444444444444/Hourly/ActivitySegments/809409600.0.plist'
			)
		).toBeNull();
		expect(
			classifyDeviceActivityFile(
				'com.apple.DeviceActivity/Local/Daily/ActivitySegments/809409600.0.plist'
			)
		).toBeNull();
		expect(
			classifyDeviceActivityFile('com.apple.DeviceActivity/Cloud/PrivateSyncState.plist')
		).toBeNull();
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
