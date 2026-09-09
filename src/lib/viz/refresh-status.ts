import type { RefreshStatus } from '../server/store';

export function refreshMessage(status: RefreshStatus | null, now: number): string {
	if (!status) return '';
	const ago = (iso?: string) => Math.max(0, Math.round((now - Date.parse(iso ?? '')) / 1000)) || 0;
	if (status.stage === 'complete')
		return `Refresh complete${status.detail ? ` · ${status.detail}` : ''}`;
	if (status.stage === 'retrying') {
		const minutes = Math.max(0, Math.ceil((Date.parse(status.retryAt!) - now) / 60_000));
		return `${minutes ? `Retry in ${minutes} min` : 'Waiting for retry'}${status.detail ? ` · ${status.detail}` : ''}`;
	}
	if (status.phase === 'requested')
		return `Queued · requested ${ago(status.requestedAt)}s ago · waiting for the mini to confirm`;
	if (status.phase !== 'running') return '';
	if (status.stage && (status.confirmed === false || ago(status.heartbeatAt) >= 60))
		return `Progress unconfirmed · last update ${ago(status.heartbeatAt)}s ago. The mini may be offline or busy.`;
	const stage =
		status.stage === 'accepted'
			? 'Mini confirmed the request'
			: status.stage === 'copying'
				? 'Creating backup on the mini'
				: 'Importing files on the mini';
	return `${stage}${status.heartbeatAt ? ` · confirmed ${ago(status.heartbeatAt)}s ago` : ''}${status.detail ? ` · ${status.detail}` : ''}`;
}
