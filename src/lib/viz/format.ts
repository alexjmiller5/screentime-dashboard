// Display helpers. Bundle-id prettification for the apps that read badly as
// their last path segment; everything else falls back to that segment.

const KNOWN: Record<string, string> = {
	'com.google.ios.youtube': 'YouTube',
	'com.burbn.instagram': 'Instagram',
	'com.apple.mobilesms': 'Messages',
	'com.apple.mobilesafari': 'Safari',
	'com.apple.incallservice': 'Phone',
	'com.google.chrome.ios': 'Chrome (iOS)',
	'com.google.chrome': 'Chrome',
	'com.spotify.client': 'Spotify',
	'net.whatsapp.whatsapp': 'WhatsApp',
	'com.facebook.messenger': 'Messenger',
	'com.google.gmail': 'Gmail',
	'com.google.maps': 'Google Maps',
	'com.apple.camera': 'Camera',
	'com.apple.mobilemail': 'Mail',
	'com.mitchellh.ghostty': 'Ghostty',
	'notion.id': 'Notion',
	'com.tinyspeck.chatlyio': 'Slack',
	'ph.telegra.telegraph': 'Telegram',
	'com.zhiliaoapp.musically': 'TikTok',
	'com.atebits.tweetie2': 'X',
	'com.reddit.reddit': 'Reddit',
	'com.anthropic.claude': 'Claude'
};

// Chrome PWAs get bundle ids of the form com.google.Chrome.app.<id>, where
// <id> is derived from the app's start URL - the same for every machine, so
// these are global facts, not personal config. Unknowns fold to "Chrome App".
const PWA: Record<string, string> = {
	agimnkijcaahngcdmfeangaknmldooml: 'YouTube (PWA)',
	akpamiohjfcnimfljfndmaldlcfphjmp: 'Instagram (PWA)',
	apmdllilnigbofopeodengghogjmoafp: 'LinkedIn (PWA)',
	hgkihejciilgdpmmojeajdlkckcmnggk: 'LinkedIn (PWA)',
	ohghonlafcimfigiajnmhdklcbjlbfda: 'LinkedIn (PWA)',
	lodlkdfmihgonocnmddehnfgiljnadcf: 'X (PWA)',
	poadcdkbdcdhpalbemobhgmmkoldoiej: 'X (PWA)',
	gfgbgjphjkdhefmnmbhogcpckgpapbag: 'Snapchat (PWA)',
	hjfgondjandamiffjejcmcnbdpcpkbpd: 'Messenger (PWA)',
	kippjfofjhjlffjecoapiogbkgbpmgej: 'Messenger (PWA)',
	kpfeiefnagdndcpdgnaompdkfenghibf: 'GroupMe (PWA)',
	mnhkaebcjjhencmpkapnbdaogjamfbcj: 'Google Maps (PWA)',
	edanbjnaiofggfmimiidpfmhggkbokck: 'Google Translate (PWA)',
	jbeoliebicnmljhmdbbdeljdpjbfollk: 'Google Contacts (PWA)',
	pmcngklofgngifnoceehmchjlildnhkj: 'Google Contacts (PWA)',
	gpbngfpopffohncaippekkbcbfbkhedf: 'WordReference (PWA)',
	jhcpobfgkhiacbheibcoilcbkoklmddb: 'WordReference (PWA)'
};

const PWA_PREFIX = 'com.google.chrome.app.';

export function appName(bundleId: string): string {
	const lower = bundleId.toLowerCase();
	if (lower.startsWith(PWA_PREFIX)) {
		return PWA[lower.slice(PWA_PREFIX.length)] ?? 'Chrome App';
	}
	const known = KNOWN[lower];
	if (known) return known;
	const segment = bundleId.split('.').pop() ?? bundleId;
	return segment.length > 0 ? segment.charAt(0).toUpperCase() + segment.slice(1) : bundleId;
}

const TERM_LABELS: Record<string, string> = {
	youtube: 'YouTube',
	instagram: 'Instagram',
	tiktok: 'TikTok',
	whatsapp: 'WhatsApp'
};

/** Watchlist term -> display label. */
export function termLabel(term: string): string {
	return TERM_LABELS[term.toLowerCase()] ?? term.charAt(0).toUpperCase() + term.slice(1);
}

export function formatDuration(seconds: number): string {
	const minutes = Math.round(seconds / 60);
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	if (h === 0) return `${m}m`;
	return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
