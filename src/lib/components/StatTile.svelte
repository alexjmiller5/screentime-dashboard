<script lang="ts">
	interface Props {
		label: string;
		value: string;
		/** Optional delta line, e.g. "-42m vs prior week". */
		delta?: string;
		/** Whether the delta is a good change (down for attention apps). */
		deltaGood?: boolean;
	}
	const { label, value, delta, deltaGood = false }: Props = $props();
</script>

<div class="flex flex-col gap-1 rounded-lg border bg-card p-4">
	<span class="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
	<span class="text-2xl font-semibold tabular-nums sm:text-3xl">{value}</span>
	{#if delta}
		<span
			class="text-xs {deltaGood ? 'text-green-700 dark:text-green-500' : 'text-muted-foreground'}"
		>
			{delta}
		</span>
	{/if}
</div>
