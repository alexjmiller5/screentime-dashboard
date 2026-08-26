<script lang="ts">
	import type { StackedSeries } from '$lib/viz/series';
	import { formatDuration } from '$lib/viz/format';

	interface Props {
		data: StackedSeries;
		labelFor?: (key: string) => string;
	}
	const { data, labelFor = (k) => k }: Props = $props();
</script>

<!-- The chart's table view (the contrast-relief channel): same data, readable
     without color. Newest days first. -->
<div class="max-h-96 overflow-auto rounded-lg border">
	<table class="w-full text-sm">
		<thead class="sticky top-0 bg-secondary">
			<tr>
				<th class="px-3 py-2 text-left font-medium">Date</th>
				{#each data.series as s (s.key)}
					<th class="px-3 py-2 text-right font-medium">{labelFor(s.key)}</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each [...data.dates].reverse() as date, ri (date)}
				{@const i = data.dates.length - 1 - ri}
				<tr class="border-t">
					<td class="px-3 py-1.5 text-muted-foreground">{date}</td>
					{#each data.series as s (s.key)}
						<td class="px-3 py-1.5 text-right tabular-nums">
							{s.data[i] > 0 ? formatDuration(s.data[i]) : '–'}
						</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
</div>
