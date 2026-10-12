// Run against an owned synthetic browser target, never a production page:
// bun scripts/test-date-range.mjs <CDP page websocket> <local dev URL>
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
	// Key events reach only the frontmost tab's focused element.
	await send('Page.bringToFront');
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
	await until("document.querySelector('[role=slider]') !== null");
	await evaluate("localStorage.removeItem('screentime:prefs')");
	const previousDocument = await evaluate('performance.timeOrigin');
	await send('Page.reload');
	await until(`performance.timeOrigin !== ${previousDocument}`);
	await until("document.querySelector('[role=slider]') !== null");
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
			`performance.timeOrigin !== ${before} && document.querySelector('[role=slider]') !== null`
		);
	}
	assert.deepEqual(await selected(), ['2026-07-08', '2026-10-06'], 'fresh visit selects 90D');
	assert.equal((await prefs()).preset, '90D');
	assert.equal(
		await evaluate(
			"document.querySelector('[aria-label=\"Start date\"]').getAttribute('aria-valuetext')"
		),
		'Jul 8, 2026'
	);
	await click('[aria-label="Start date"]');
	await send('Input.dispatchKeyEvent', {
		type: 'keyDown',
		key: 'ArrowRight',
		code: 'ArrowRight',
		windowsVirtualKeyCode: 39
	});
	await send('Input.dispatchKeyEvent', {
		type: 'keyUp',
		key: 'ArrowRight',
		code: 'ArrowRight',
		windowsVirtualKeyCode: 39
	});
	await until("JSON.parse(localStorage.getItem('screentime:prefs')).dateStart === '2026-07-09'");
	assert.equal((await prefs()).preset, '', 'keyboard adjustment selects Custom');
	await reload();
	assert.deepEqual(await selected(), ['2026-07-09', '2026-10-06'], 'Custom dates survive reload');
	// Dragging the filled span (just before the start handle) slides the whole window.
	const drag = await evaluate(
		`(()=>{const r=document.querySelector('[aria-label="Start date"]').previousElementSibling.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`
	);
	await send('Input.dispatchMouseEvent', {
		type: 'mousePressed',
		button: 'left',
		clickCount: 1,
		...drag
	});
	await send('Input.dispatchMouseEvent', {
		type: 'mouseMoved',
		button: 'left',
		buttons: 1,
		x: drag.x - 40,
		y: drag.y
	});
	await send('Input.dispatchMouseEvent', {
		type: 'mouseReleased',
		button: 'left',
		clickCount: 1,
		x: drag.x - 40,
		y: drag.y
	});
	await until("JSON.parse(localStorage.getItem('screentime:prefs')).dateStart < '2026-07-09'");
	const afterDrag = await selected();
	assert.equal(
		Date.parse(afterDrag[1]) - Date.parse(afterDrag[0]),
		89 * 86400000,
		'whole-window drag preserves selected width'
	);
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
	await send('Input.dispatchKeyEvent', {
		type: 'keyDown',
		key: 'End',
		code: 'End',
		windowsVirtualKeyCode: 35
	});
	await send('Input.dispatchKeyEvent', {
		type: 'keyUp',
		key: 'End',
		code: 'End',
		windowsVirtualKeyCode: 35
	});
	await until("JSON.parse(localStorage.getItem('screentime:prefs')).dateStart === '2024-01-29'");
	await evaluate("localStorage.removeItem('screentime:prefs')");
	await reload();
	await send('Emulation.setDeviceMetricsOverride', {
		width: 390,
		height: 844,
		deviceScaleFactor: 1,
		mobile: true
	});
	await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
	await reload();
	assert.equal(
		await evaluate('document.documentElement.scrollWidth <= innerWidth'),
		true,
		'390px layout has no horizontal page overflow'
	);
	// Touch handles grow to 24px after a short transition.
	await until(
		'document.querySelector(\'[aria-label="Start date"]\').getBoundingClientRect().width >= 24'
	);
	if (process.env.SCREENSHOT_PATH) {
		const { data } = await send('Page.captureScreenshot', { format: 'png' });
		await Bun.write(process.env.SCREENSHOT_PATH, Buffer.from(data, 'base64'));
	}
	console.log(
		'PASS: 90D default, keyboard dates, span drag, Home/End, reload, composed filters, malformed dates, 390px touch layout'
	);
} finally {
	await send('Emulation.clearDeviceMetricsOverride');
	await send('Emulation.setTouchEmulationEnabled', { enabled: false });
	if (injection) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection });
	socket.close();
}
