import { describe, expect, it } from 'vitest';
import { appName, appColor, appIcon, paletteIndex, formatDuration, formatAverage } from './format';

describe('appName', () => {
	it('prettifies known bundles and falls back to the last segment', () => {
		expect(appName('com.google.ios.youtube')).toBe('YouTube');
		expect(appName('com.burbn.instagram')).toBe('Instagram');
		expect(appName('com.apple.MobileSMS')).toBe('Messages');
		expect(appName('com.google.chrome.ios')).toBe('Chrome'); // Apple canonicalizes desktop Chrome to the iOS id
		expect(appName('com.apple.mobilemail')).toBe('Mail');
		expect(appName('com.apple.mobilenotes')).toBe('Notes');
		expect(appName('com.apple.mobileslideshow')).toBe('Photos');
		expect(appName('com.apple.mobiletimer')).toBe('Clock');
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

	it('renders web-domain keys as the bare domain', () => {
		expect(appName('web:movies.example.test')).toBe('movies.example.test');
	});
});

describe('app identity visuals', () => {
	it('returns the brand color for known apps, their domains, and PWAs', () => {
		expect(appColor('YouTube')).toBe('#FF0000');
		expect(appColor('youtube.com')).toBe('#FF0000'); // same identity via the domain
		expect(appColor('Instagram (PWA)')).toBe('#E4405F');
		expect(appColor('SomeRandomApp')).toBeNull();
	});

	it('never returns pure black (invisible on the dark surface)', () => {
		for (const key of ['Notion', 'X', 'TikTok']) {
			expect(appColor(key)).not.toBeNull();
			expect(appColor(key)).not.toBe('#000000');
		}
	});

	it('returns an icon URL for known apps and a favicon for unknown domains', () => {
		expect(appIcon('YouTube')).toContain('selfhst:youtube');
		expect(appIcon('Messages')).toContain('tabler:'); // Apple apps: tinted glyphs
		expect(appIcon('obscure-site.example')).toContain('obscure-site.example');
		expect(appIcon('SomeRandomApp')).toBeNull();
	});

	it('hashes unknown keys to a stable palette slot 0-7', () => {
		const i = paletteIndex('SomeRandomApp');
		expect(i).toBe(paletteIndex('SomeRandomApp'));
		expect(i).toBeGreaterThanOrEqual(0);
		expect(i).toBeLessThan(8);
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

describe('formatAverage', () => {
	it('scales the daily rate to the active bucket', () => {
		expect(formatAverage(3600, 'day')).toBe('avg 1h/day');
		expect(formatAverage(3600, 'week')).toBe('avg 7h/week');
		// 30.44 average days per month
		expect(formatAverage(3600, 'month')).toBe('avg 30h 26m/month');
	});

	it('handles zero', () => {
		expect(formatAverage(0, 'week')).toBe('avg 0m/week');
	});
});
