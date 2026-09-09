import { beforeEach, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { readFileSync } from 'node:fs';
import { GET, POST, PUT, DELETE } from './+server';
import type { Marker } from '$lib/viz/markers';

const SQL = await initSqlJs();
let db: InstanceType<typeof SQL.Database>;
beforeEach(() => {
	db = new SQL.Database();
	db.run(readFileSync('migrations/0003_markers.sql', 'utf8'));
	return () => db.close();
});
// Execute the route's actual bound SQL against SQLite, including the migration.
function event(method: string, body?: unknown, id?: string) {
	const platform = {
		env: {
			DB: {
				prepare(sql: string) {
					let values: (string | number)[] = [];
					return {
						bind(...args: (string | number)[]) {
							values = args;
							return this;
						},
						async all() {
							const s = db.prepare(sql);
							s.bind(values);
							const results = [];
							while (s.step()) results.push(s.getAsObject());
							s.free();
							return { results };
						},
						async first() {
							return (await this.all()).results[0] ?? null;
						},
						async run() {
							db.run(sql, values);
							return { meta: { changes: db.getRowsModified() } };
						}
					};
				}
			}
		}
	};
	const url = new URL('https://example.com/api/markers');
	if (id) url.searchParams.set('id', id);
	return {
		platform,
		url,
		request: new Request(url, {
			method,
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		})
	} as Parameters<typeof GET>[0];
}

it('creates, lists, edits and deletes persisted markers without replacing their identity', async () => {
	const created = await POST(event('POST', { date: '2024-02-29', title: "  Example's event  " }));
	expect(created.status).toBe(201);
	const marker = (await created.json()) as Marker;
	expect(marker).toMatchObject({ date: '2024-02-29', title: "Example's event" });
	expect((await GET(event('GET'))).headers.get('cache-control')).toContain('no-store');
	const update = await PUT(event('PUT', { ...marker, date: '2024-03-01', title: 'Revised event' }));
	expect(await update.json()).toEqual({
		id: marker.id,
		date: '2024-03-01',
		title: 'Revised event'
	});
	expect(await (await GET(event('GET'))).json()).toEqual({
		markers: [{ id: marker.id, date: '2024-03-01', title: 'Revised event' }]
	});
	expect((await DELETE(event('DELETE', undefined, marker.id))).status).toBe(204);
	expect(await (await GET(event('GET'))).json()).toEqual({ markers: [] });
	expect((await DELETE(event('DELETE', undefined, marker.id))).status).toBe(404);
	expect((await PUT(event('PUT', marker))).status).toBe(404);
});

it('rejects bad JSON, invalid dates and missing identities without writing', async () => {
	const bad = event('POST');
	bad.request = new Request(bad.url, { method: 'POST', body: '{' });
	expect((await POST(bad)).status).toBe(400);
	expect((await POST(event('POST', { date: '2023-02-29', title: 'Event' }))).status).toBe(400);
	expect((await PUT(event('PUT', { date: '2024-01-01', title: 'Event' }))).status).toBe(400);
	expect((await DELETE(event('DELETE'))).status).toBe(400);
	expect(await (await GET(event('GET'))).json()).toEqual({ markers: [] });
});

it('sorts by date and retains separate events on the same date', async () => {
	for (const [date, title] of [
		['2024-03-01', 'Later'],
		['2024-01-01', 'First'],
		['2024-01-01', 'Second']
	]) {
		await POST(event('POST', { date, title }));
	}
	const { markers } = (await (await GET(event('GET'))).json()) as { markers: Marker[] };
	expect(markers.map((m: { title: string }) => m.title)).toEqual(['First', 'Second', 'Later']);
});
