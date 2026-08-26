import { describe, expect, it } from 'vitest';
import { appName, formatDuration, termLabel } from './format';

describe('appName', () => {
	it('prettifies known bundles and falls back to the last segment', () => {
		expect(appName('com.google.ios.youtube')).toBe('YouTube');
		expect(appName('com.burbn.instagram')).toBe('Instagram');
		expect(appName('com.apple.MobileSMS')).toBe('Messages');
		expect(appName('com.google.chrome.ios')).toBe('Chrome (iOS)');
		expect(appName('com.google.Chrome')).toBe('Chrome');
		expect(appName('com.somevendor.CoolThing')).toBe('CoolThing');
		expect(appName('Other')).toBe('Other');
	});

	it('names Chrome PWAs by their app (ids are URL-derived and global)', () => {
		expect(appName('com.google.Chrome.app.agimnkijcaahngcdmfeangaknmldooml')).toBe('YouTube (PWA)');
		expect(appName('com.google.Chrome.app.akpamiohjfcnimfljfndmaldlcfphjmp')).toBe(
			'Instagram (PWA)'
		);
		expect(appName('com.google.Chrome.app.zzzzunknownzzzz')).toBe('Chrome App');
	});
});

describe('termLabel', () => {
	it('title-cases known watchlist terms, capitalizes the rest', () => {
		expect(termLabel('youtube')).toBe('YouTube');
		expect(termLabel('instagram')).toBe('Instagram');
		expect(termLabel('tiktok')).toBe('TikTok');
		expect(termLabel('reddit')).toBe('Reddit');
	});
});

describe('formatDuration', () => {
	it('renders seconds as compact h/m', () => {
		expect(formatDuration(0)).toBe('0m');
		expect(formatDuration(59)).toBe('1m');
		expect(formatDuration(1800)).toBe('30m');
		expect(formatDuration(3600)).toBe('1h');
		expect(formatDuration(5400)).toBe('1h 30m');
		expect(formatDuration(36000)).toBe('10h');
	});
});
