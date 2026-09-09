// Device labels, edited in the dashboard's device dialog.

import type { RequestHandler } from '@sveltejs/kit';
import { insertStatements, metaStatements, runStatements } from '$lib/server/store';

export const PUT: RequestHandler = async ({ platform, request }) => {
	const labels = (await request.json()) as Record<string, unknown>;
	const rows = Object.entries(labels).filter(
		(e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== ''
	);
	if (rows.length === 0) return new Response('no labels', { status: 400 });
	await runStatements(platform!.env.DB, [
		...metaStatements({ data_updated_at: new Date().toISOString() }),
		...insertStatements(
			'devices',
			['id', 'label'],
			rows.map(([id, l]) => [id, l.trim()]),
			'ON CONFLICT (id) DO UPDATE SET label = excluded.label'
		)
	]);
	return new Response(null, { status: 204 });
};
