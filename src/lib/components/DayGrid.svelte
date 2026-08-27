<script lang="ts">
	import type { DayGridCell } from '$lib/viz/series';
	import { readChartTheme, type ChartTheme } from '$lib/viz/theme';
	import { formatDuration } from '$lib/viz/format';
	import { onMount } from 'svelte';

	interface Props {
		dates: string[];
		/** [dateIndex][hour] from dayGridCells. */
		cells: (DayGridCell | null)[][];
		/** Chart series keys in palette order (without Other) - keeps the grid's
		 * colors consistent with the stacked chart. */
		namedKeys: string[];
	}
	const { dates, cells, namedKeys }: Props = $props();

	let theme = $state<ChartTheme | null>(null);
	onMount(() => (theme = readChartTheme()));

	const colorFor = (key: string): string => {
		if (!theme) return 'transparent';
		const i = namedKeys.indexOf(key);
		return i >= 0 ? theme.series[i % theme.series.length] : theme.otherGray;
	};
	/** Partial hours fade: 15m of use reads lighter than a full hour. */
	const alphaFor = (seconds: number): number => 0.25 + 0.75 * Math.min(1, seconds / 3600);

	const cellTitle = (date: string, hour: number, cell: DayGridCell): string =>
		`${date} ${String(hour).padStart(2, '0')}:00 · ${formatDuration(cell.seconds)}\n` +
		cell.top.map((t) => `${t.key}: ${formatDuration(t.seconds)}`).join('\n');

	const xLabelEvery = $derived(Math.max(1, Math.ceil(dates.length / 10)));
</script>

<!-- Day-rhythm grid: columns = days, rows = the 24 hours; each cell is the
     hour's dominant app in the stacked chart's colors. Blank = screen off. -->
<div class="flex gap-2">
	<div class="grid shrink-0 grid-rows-[repeat(24,10px)] gap-px text-right">
		{#each [0, 6, 12, 18] as h (h)}
			<span class="text-[10px] text-muted-foreground tabular-nums" style="grid-row: {h + 1}">
				{String(h).padStart(2, '0')}
			</span>
		{/each}
	</div>
	<div class="min-w-0 flex-1 overflow-x-auto">
		<div
			class="grid gap-px"
			style="grid-template-columns: repeat({dates.length}, minmax(6px, 1fr)); grid-template-rows: repeat(24, 10px)"
		>
			{#each dates as date, di (date)}
				{#each cells[di] as cell, hour (hour)}
					{#if cell}
						<div
							class="rounded-[2px]"
							style="grid-column: {di + 1}; grid-row: {hour + 1}; background: {colorFor(
								cell.key
							)}; opacity: {alphaFor(cell.seconds)}"
							title={cellTitle(date, hour, cell)}
						></div>
					{/if}
				{/each}
			{/each}
		</div>
		<div
			class="mt-1 grid gap-px"
			style="grid-template-columns: repeat({dates.length}, minmax(6px, 1fr))"
		>
			{#each dates as date, di (date)}
				{#if di % xLabelEvery === 0}
					<span
						class="col-span-1 text-[10px] whitespace-nowrap text-muted-foreground"
						style="grid-column: {di + 1}"
					>
						{date.slice(5)}
					</span>
				{/if}
			{/each}
		</div>
	</div>
</div>
