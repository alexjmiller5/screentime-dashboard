// Display helpers. Bundle-id prettification for the apps that read badly as
// their last path segment; everything else falls back to that segment.

const KNOWN: Record<string, string> = {
	'com.google.ios.youtube': 'YouTube',
	'com.burbn.instagram': 'Instagram',
	'com.apple.mobilesms': 'Messages',
	'com.apple.mobilesafari': 'Safari',
	'com.apple.incallservice': 'Phone',
	'com.google.chrome.ios': 'Chrome', // Apple's unified cross-platform id - also Mac desktop Chrome in Screen Time data
	'com.google.chrome': 'Chrome',
	'com.spotify.client': 'Spotify',
	'net.whatsapp.whatsapp': 'WhatsApp',
	'com.facebook.messenger': 'Messenger',
	'com.google.gmail': 'Gmail',
	'com.google.maps': 'Google Maps',
	'com.apple.camera': 'Camera',
	'com.apple.mobilemail': 'Mail',
	'com.apple.mail': 'Mail',
	'com.apple.mobilenotes': 'Notes',
	'com.apple.mobileslideshow': 'Photos',
	'com.apple.mobiletimer': 'Clock',
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
	if (bundleId.startsWith('web:')) return bundleId.slice(4); // website usage rows
	const lower = bundleId.toLowerCase();
	if (lower.startsWith(PWA_PREFIX)) {
		return PWA[lower.slice(PWA_PREFIX.length)] ?? 'Chrome App';
	}
	const known = KNOWN[lower];
	if (known) return known;
	const segment = bundleId.split('.').pop() ?? bundleId;
	return segment.length > 0 ? segment.charAt(0).toUpperCase() + segment.slice(1) : bundleId;
}

// App identity visuals, keyed by NORMALIZED display key (appName output or a
// web domain): brand color + logo. Icons per the icon standard - selfhst for
// brand logos, tinted Tabler glyphs for Apple system apps selfhst lacks,
// favicons for arbitrary domains. Black brands wear a dark-safe gray instead
// of #000 (invisible on the dark card surface).
const selfhst = (slug: string): string => `https://api.iconify.design/selfhst:${slug}.svg`;
const tabler = (slug: string, hex: string): string =>
	`https://api.iconify.design/tabler:${slug}.svg?color=%23${hex}`;

const BRAND: Record<string, { color?: string; icon?: string }> = {
	youtube: { color: '#FF0000', icon: selfhst('youtube') },
	instagram: { color: '#E4405F', icon: selfhst('instagram') },
	messages: { color: '#34C759', icon: tabler('message-circle-filled', '34C759') },
	phone: { color: '#34C759', icon: tabler('phone-filled', '34C759') },
	safari: { color: '#1E9BF6', icon: selfhst('safari') },
	chrome: { color: '#4285F4', icon: selfhst('google-chrome') },
	'chrome app': { color: '#4285F4', icon: selfhst('google-chrome') },
	spotify: { color: '#1DB954', icon: selfhst('spotify') },
	whatsapp: { color: '#25D366', icon: selfhst('whatsapp') },
	messenger: { color: '#0084FF', icon: selfhst('facebook-messenger') },
	gmail: { color: '#EA4335', icon: selfhst('gmail') },
	'google maps': { color: '#34A853', icon: selfhst('google-maps') },
	'google translate': { icon: selfhst('google-translate') },
	'google contacts': { icon: selfhst('google-contacts') },
	google: { color: '#4285F4' },
	camera: { color: '#8E8E93', icon: tabler('camera-filled', '8E8E93') },
	mail: { color: '#007AFF', icon: tabler('mail-filled', '007AFF') },
	notes: { color: '#FFD60A', icon: tabler('notes', 'FFD60A') },
	photos: { color: '#FF9F0A', icon: tabler('photo-filled', 'FF9F0A') },
	clock: { color: '#8E8E93', icon: tabler('clock-filled', '8E8E93') },
	ghostty: { color: '#3551F3', icon: selfhst('ghostty') },
	preferences: { color: '#8E8E93', icon: tabler('settings-filled', '8E8E93') },
	vscode: { color: '#007ACC', icon: selfhst('visual-studio-code') },
	notion: { color: '#6E6E73', icon: selfhst('notion') },
	slack: { color: '#E01E5A', icon: selfhst('slack') },
	telegram: { color: '#26A5E4', icon: selfhst('telegram') },
	tiktok: { color: '#FE2C55', icon: selfhst('tiktok') },
	x: { color: '#71767B', icon: selfhst('x') },
	twitter: { color: '#1D9BF0', icon: selfhst('twitter') },
	reddit: { color: '#FF4500', icon: selfhst('reddit') },
	claude: { color: '#D97757', icon: selfhst('claude') },
	snapchat: { color: '#FFFC00', icon: selfhst('snapchat') },
	linkedin: { color: '#0A66C2', icon: selfhst('linkedin') },
	groupme: { color: '#00AFF0', icon: tabler('messages', '00AFF0') },
	github: { color: '#6E6E73' },
	netflix: { color: '#E50914' },
	amazon: { color: '#FF9900' },
	twitch: { color: '#9146FF' },
	chatgpt: { color: '#74AA9C' }
};

/** 'Instagram (PWA)' / 'youtube.com' / 'YouTube' -> the same brand key. */
function normalizeKey(key: string): string {
	return key
		.toLowerCase()
		.replace(/ \(pwa\)$/, '')
		.replace(/^www\./, '')
		.replace(/\.(com|org|net|io|app|ai|tv|co|gg)$/, '');
}

/** Brand color for a display key (app name or web domain), or null. */
export function appColor(key: string): string | null {
	return BRAND[normalizeKey(key)]?.color ?? null;
}

/** Icon URL for a display key: brand logo, or the site favicon for domains. */
export function appIcon(key: string): string | null {
	const icon = BRAND[normalizeKey(key)]?.icon;
	if (icon) return icon;
	if (key.includes('.')) {
		return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(key)}&sz=64`;
	}
	return null;
}

/** Stable 0-7 slot in the token palette for keys without a brand color. */
export function paletteIndex(key: string): number {
	let h = 0;
	for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
	return h % 8;
}

export function formatDuration(seconds: number): string {
	const minutes = Math.round(seconds / 60);
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	if (h === 0) return `${m}m`;
	return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
