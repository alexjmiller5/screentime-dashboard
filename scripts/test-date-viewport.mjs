// Run against an owned synthetic browser target, never a production page:
// bun scripts/test-date-viewport.mjs <CDP page websocket> <local dev URL>
import assert from 'node:assert/strict';
const [socketUrl, url] = process.argv.slice(2);
if (!socketUrl || !/^http:\/\/(localhost|127\.0\.0\.1):\d+\/$/.test(url ?? '')) {
	throw new Error('Provide a CDP page websocket and a local dev URL');
}
const socket = new WebSocket(socketUrl);
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
let seq = 0;
const pending = new Map();
socket.addEventListener('message', ({ data }) => {
	const message = JSON.parse(data);
	if (message.id) {
		const callback = pending.get(message.id);
		pending.delete(message.id);
		callback?.(message);
	}
});
function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = ++seq;
		pending.set(id, (message) => (message.error ? reject(message.error) : resolve(message.result)));
		socket.send(JSON.stringify({ id, method, params }));
	});
}
async function evaluate(expression) {
	const result = await send('Runtime.evaluate', {
		expression,
		returnByValue: true,
		awaitPromise: true
	});
	if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
	return result.result.value;
}
async function until(expression) {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			if (await evaluate(expression)) return;
		} catch (error) {
			if (!/navigated|context.*destroyed|Cannot find context/i.test(error.message ?? ''))
				throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out: ${expression}`);
}
const fixture = {
	version: 1,
	importedAt: '2026-10-06T12:00:00Z',
	timeZone: 'America/New_York',
	devices: { device1: 'Laptop', device2: 'Phone' },
	rows: ['2020-01-01', '2026-07-08', '2026-10-05', '2026-10-06'].flatMap((date) =>
		['device1', 'device2'].map((device) => ({
			source: 'infocus',
			date,
			device,
			bundleId: 'com.apple.Safari',
			seconds: 3600
		}))
	),
	hourly: [],
	sessions: [],
	websiteHours: []
};
let injection;
try {
	await send('Page.enable');
	({ identifier: injection } = await send('Page.addScriptToEvaluateOnNewDocument', {
		source: `
		const originalFetch = window.fetch;
		window.fetch = async (input, options) => {
			const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
			if (!path.startsWith('/api/')) return originalFetch(input, options);
			if (options?.method && options.method !== 'GET') throw new Error('Synthetic test forbids writes');
			return Response.json(path === '/api/usage' ? ${JSON.stringify(fixture)} : path === '/api/markers' ? {markers: []} : {phase: 'idle', pending: false});
		};
	`
	}));
	await send('Page.navigate', { url });
	await until("document.querySelector('nav[aria-label]') !== null");
	await evaluate("localStorage.removeItem('screentime:prefs')");
	const previousDocument = await evaluate('performance.timeOrigin');
	await send('Page.reload');
	await until(`performance.timeOrigin !== ${previousDocument}`);
	await until("document.querySelector('nav[aria-label]') !== null");
	assert.equal(
		await evaluate(
			"document.querySelector('[aria-label=\"Date viewport\"]')?.textContent.includes('Jul 8, 2026')"
		),
		true,
		'initial viewport shows trailing 90 days, not full archive'
	);
	console.log('PASS: initial bounded viewport');
	const prefs = () => evaluate("JSON.parse(localStorage.getItem('screentime:prefs'))");
	const selected = async () => {
		const p = await prefs();
		return [p.dateStart, p.dateEnd];
	};
	async function click(selector) {
		const rect = await evaluate(
			`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`
		);
		await send('Input.dispatchMouseEvent', {
			type: 'mousePressed',
			button: 'left',
			clickCount: 1,
			...rect
		});
		await send('Input.dispatchMouseEvent', {
			type: 'mouseReleased',
			button: 'left',
			clickCount: 1,
			...rect
		});
	}
	async function reload() {
		const before = await evaluate('performance.timeOrigin');
		await send('Page.reload');
		await until(
			`performance.timeOrigin !== ${before} && document.querySelector('nav[aria-label]') !== null`
		);
	}
	const original = await selected();
	await click('[aria-label="Show earlier dates"]');
	await until(
		"document.querySelector('[aria-label=\"Date viewport\"]').textContent.includes('Jun 8, 2026')"
	);
	assert.deepEqual(
		await selected(),
		original,
		'viewport navigation leaves selected dates unchanged'
	);
	assert.equal((await prefs()).preset, '90D');
	await click('[aria-label="Show later dates"]');
	await click('[aria-label="Start date"]');
	await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' });
	await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight' });
	await until("JSON.parse(localStorage.getItem('screentime:prefs')).dateStart === '2026-07-09'");
	assert.equal((await prefs()).preset, '', 'keyboard adjustment selects Custom');
	await reload();
	assert.deepEqual(await selected(), ['2026-07-09', '2026-10-06'], 'Custom dates survive reload');
	// A held pointer continues panning even without subsequent pointermove events.
	const drag = await evaluate(
		`(()=>{const e=document.querySelector('[aria-label="Move selected date range"]');const r=e.getBoundingClientRect();const t=e.parentElement.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,left:t.left}})()`
	);
	await send('Input.dispatchMouseEvent', {
		type: 'mousePressed',
		button: 'left',
		clickCount: 1,
		x: drag.x,
		y: drag.y
	});
	await send('Input.dispatchMouseEvent', {
		type: 'mouseMoved',
		button: 'left',
		buttons: 1,
		x: drag.left - 8,
		y: drag.y
	});
	const afterMove = await selected();
	await new Promise((resolve) => setTimeout(resolve, 350));
	const afterHold = await selected();
	await send('Input.dispatchMouseEvent', {
		type: 'mouseReleased',
		button: 'left',
		clickCount: 1,
		x: drag.left - 8,
		y: drag.y
	});
	assert.ok(
		afterHold[0] < afterMove[0],
		'stationary pointer beyond edge keeps panning into history'
	);
	assert.equal(
		Date.parse(afterHold[1]) - Date.parse(afterHold[0]),
		89 * 86400000,
		'whole-window drag preserves selected width'
	);
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.deepEqual(await selected(), afterHold, 'pointer release stops panning');
	// Validate independent per-device restoration of the existing composed filters.
	await evaluate(
		`localStorage.setItem('screentime:prefs',JSON.stringify({preset:'30D',bucket:'week',view:'hourly',showTable:true,measuredBy:'infocus',excludedDevices:['Phone'],picked:['Safari'],savedApps:['Safari']}))`
	);
	await reload();
	const restored = await prefs();
	assert.deepEqual(
		[
			restored.preset,
			restored.bucket,
			restored.view,
			restored.showTable,
			restored.measuredBy,
			restored.excludedDevices,
			restored.picked
		],
		['30D', 'week', 'hourly', true, 'infocus', ['Phone'], ['Safari']]
	);
	assert.deepEqual(
		await selected(),
		['2026-09-06', '2026-10-06'],
		'relative preset recomputes dates'
	);
	await evaluate(
		`localStorage.setItem('screentime:prefs',JSON.stringify({preset:'',dateStart:'2026-02-29',dateEnd:'invalid',bucket:'month'}))`
	);
	await reload();
	assert.equal((await prefs()).preset, '90D', 'invalid date fields fall back independently');
	assert.equal((await prefs()).bucket, 'month');
	await evaluate(
		`localStorage.setItem('screentime:prefs',JSON.stringify({preset:'',dateStart:'2024-01-01',dateEnd:'2024-01-30'}))`
	);
	await reload();
	await click('[aria-label="Start date"]');
	await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End' });
	await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End' });
	await until("JSON.parse(localStorage.getItem('screentime:prefs')).dateStart === '2024-01-30'");
	assert.ok(
		await evaluate(
			"document.querySelector('[aria-label=\"Date viewport\"]').textContent.includes('Jan 30, 2024')"
		),
		'Home/End keeps the actually clamped handle visible'
	);
	await evaluate("localStorage.removeItem('screentime:prefs')");
	await reload();
	await send('Emulation.setDeviceMetricsOverride', {
		width: 390,
		height: 844,
		deviceScaleFactor: 1,
		mobile: true
	});
	assert.equal(
		await evaluate('document.documentElement.scrollWidth <= innerWidth'),
		true,
		'390px layout has no horizontal page overflow'
	);
	assert.ok(
		await evaluate(
			'document.querySelector(\'[aria-label="Start date"]\').getBoundingClientRect().width >= 44'
		),
		'touch targets are at least 44px wide'
	);
	if (process.env.SCREENSHOT_PATH) {
		const { data } = await send('Page.captureScreenshot', { format: 'png' });
		await Bun.write(process.env.SCREENSHOT_PATH, Buffer.from(data, 'base64'));
	}
	console.log(
		'PASS: viewport navigation, keyboard dates, edge hold/release, range width, reload, composed filters, malformed dates, 390px layout'
	);
} finally {
	await send('Emulation.clearDeviceMetricsOverride');
	if (injection) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection });
	socket.close();
}
