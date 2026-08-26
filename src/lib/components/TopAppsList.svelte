<script lang="ts">
	import { appName, formatDuration } from '$lib/viz/format';

	interface Props {
		apps: { bundleId: string; seconds: number }[];
	}
	const { apps }: Props = $props();
	const max = $derived(apps.length > 0 ? apps[0].seconds : 1);
</script>

<!-- Nominal magnitude comparison: every bar wears slot-1 (identity is the row
     label, length is the data) with the value labeled at the tip. -->
<ol class="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
	{#each apps as app (app.bundleId)}
		<li class="grid grid-cols-[8rem_1fr_4.5rem] items-center gap-3 text-sm">
			<span class="truncate text-foreground" title={app.bundleId}>{appName(app.bundleId)}</span>
			<span class="h-4 overflow-hidden rounded-sm bg-secondary">
				<span
					class="block h-full rounded-sm bg-chart-1"
					style="width: {Math.max(1, (app.seconds / max) * 100)}%"
				></span>
			</span>
			<span class="text-right text-xs text-muted-foreground tabular-nums">
				{formatDuration(app.seconds)}
			</span>
		</li>
	{/each}
</ol>
