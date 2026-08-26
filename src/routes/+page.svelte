<script lang="ts">
	import { onMount } from 'svelte';
	import { IconFolderOpen, IconTable, IconChartBar } from '@tabler/icons-svelte';
	import Seo from '$lib/components/seo.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import StackedChart from '$lib/components/StackedChart.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import TopAppsList from '$lib/components/TopAppsList.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import ImportDialog from '$lib/components/ImportDialog.svelte';
	import type { UsageCache, UsageRow } from '$lib/data/cache';
	import type { ImportResult } from '$lib/import/importer';
	import {
		filterRows,
		dailyByApp,
		topApps,
		watchlistDaily,
		matchesTerm,
		rollingMean,
		dateRange
	} from '$lib/viz/series';
	import { appName, formatDuration, termLabel } from '$lib/viz/format';

	const WATCHLIST_KEY = 'screentime:watchlist';

	let cache = $state<UsageCache | null>(null);
	let loading = $state(true);
	let importState: 'idle' | 'scanning' | 'labeling' | 'uploading' = $state('idle');
	let importProgress = $state('');
	let importError = $state('');
	let scan = $state<ImportResult | null>(null);

	let rangeDays = $state('90');
	let source = $state<UsageRow['source']>('infocus');
	// Screen Time rows carry apps AND web domains as parallel breakdowns of the
	// same minutes - never summed together, so the view picks one.
	let stView = $state<'apps' | 'websites'>('apps');
	let excludedDevices: string[] = $state([]);
	let watchlistText = $state('youtube, instagram');
	let showTable = $state(false);

	onMount(async () => {
		watchlistText = localStorage.getItem(WATCHLIST_KEY) ?? watchlistText;
		const res = await fetch('/api/usage');
		if (res.ok) cache = (await res.json()) as UsageCache;
		loading = false;
	});

	const watchlist = $derived(
		watchlistText
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean)
	);
	$effect(() => localStorage.setItem(WATCHLIST_KEY, watchlistText));

	const allSourceRows = $derived(
		cache ? filterRows(cache.rows, { source, devices: undefined }) : []
	);
	const sourceRows = $derived(
		source === 'screentime'
			? allSourceRows.filter((r) => r.bundleId.startsWith('web:') === (stView === 'websites'))
			: allSourceRows
	);
	const deviceIds = $derived([...new Set(sourceRows.map((r) => r.device))].sort());
	const lastDate = $derived(
		sourceRows.length > 0 ? sourceRows.reduce((m, r) => (r.date > m ? r.date : m), '') : ''
	);
	const startDate = $derived(
		rangeDays === 'all' || lastDate === ''
			? undefined
			: new Date(Date.parse(lastDate) - (Number(rangeDays) - 1) * 86_400_000)
					.toISOString()
					.slice(0, 10)
	);
	const rows = $derived(
		filterRows(sourceRows, {
			source,
			startDate,
			endDate: lastDate || undefined,
			devices: deviceIds.filter((d) => !excludedDevices.includes(d))
		})
	);

	// 8 named series = every validated palette slot; the rest folds to Other in
	// the chart, but the ranked list below shows everything.
	const stacked = $derived(dailyByApp(rows, 8));
	const ranked = $derived(topApps(rows, Infinity));

	// Watchlist trend over the full source history (the point is the long arc),
	// smoothed with a 7-day rolling mean.
	const watchTrend = $derived.by(() => {
		const daily = watchlistDaily(allSourceRows, watchlist);
		return {
			dates: daily.dates,
			series: daily.series.map((s) => ({
				key: `${termLabel(s.key)} · 7d avg`,
				data: rollingMean(s.data, 7)
			}))
		};
	});

	// KPIs: this week vs prior week, from the source rows (all devices).
	const kpis = $derived.by(() => {
		if (lastDate === '') return null;
		const day = 86_400_000;
		const end = Date.parse(lastDate);
		const week = (offset: number): Set<string> =>
			new Set(
				dateRange(
					new Date(end - (offset + 6) * day).toISOString().slice(0, 10),
					new Date(end - offset * day).toISOString().slice(0, 10)
				)
			);
		const sum = (dates: Set<string>, match?: (b: string) => boolean): number =>
			sourceRows.reduce(
				(acc, r) => (dates.has(r.date) && (!match || match(r.bundleId)) ? acc + r.seconds : acc),
				0
			);
		const inWatchlist = (b: string): boolean => watchlist.some((t) => matchesTerm(b, t));
		const thisWeek = sum(week(0));
		const priorWeek = sum(week(7));
		const sumAll = (dates: Set<string>, match: (b: string) => boolean): number =>
			allSourceRows.reduce(
				(acc, r) => (dates.has(r.date) && match(r.bundleId) ? acc + r.seconds : acc),
				0
			);
		const watchWeek = sumAll(week(0), inWatchlist);
		const watchPrior = sumAll(week(7), inWatchlist);
		return { thisWeek, priorWeek, watchWeek, watchPrior };
	});

	const delta = (now: number, prior: number): string => {
		if (prior === 0) return 'no prior week';
		const diff = now - prior;
		return `${diff <= 0 ? '−' : '+'}${formatDuration(Math.abs(diff))} vs prior week`;
	};

	async function startImport(): Promise<void> {
		importError = '';
		importState = 'scanning';
		try {
			const { scanBackupsFolder } = await import('$lib/import/run');
			scan = await scanBackupsFolder((msg) => (importProgress = msg));
			importState = 'labeling';
		} catch (error) {
			importState = 'idle';
			if (!(error instanceof DOMException && error.name === 'AbortError')) {
				importError = error instanceof Error ? error.message : String(error);
			}
		}
	}

	async function confirmImport(labels: Record<string, string>): Promise<void> {
		if (!scan) return;
		importState = 'uploading';
		try {
			const { uploadCache } = await import('$lib/import/run');
			cache = await uploadCache(scan, labels);
			scan = null;
			importState = 'idle';
		} catch (error) {
			importState = 'labeling';
			importError = error instanceof Error ? error.message : String(error);
		}
	}

	const deviceLabel = (id: string): string => cache?.devices[id] ?? id.slice(0, 8);
</script>

<Seo
	title="Screen Time Dashboard"
	description="App usage over time across my devices, from screentime-backup snapshots"
/>

<div class="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
	<header class="flex flex-wrap items-start justify-between gap-4">
		<div>
			<h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">Screen Time</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				App usage across devices, from weekly screentime-backup snapshots.
			</p>
		</div>
		<Button onclick={startImport} disabled={importState === 'scanning'}>
			<IconFolderOpen size={18} />
			{importState === 'scanning' ? importProgress || 'Scanning…' : 'Import backups'}
		</Button>
	</header>

	{#if importError}
		<p class="text-sm text-destructive">{importError}</p>
	{/if}

	{#if loading}
		<p class="py-24 text-center text-sm text-muted-foreground">Loading…</p>
	{:else if !cache}
		<div class="flex flex-col items-center gap-3 rounded-lg border bg-card px-6 py-20 text-center">
			<IconChartBar size={40} class="text-muted-foreground" />
			<h2 class="text-lg font-medium">No data yet</h2>
			<p class="max-w-md text-sm text-muted-foreground">
				Click <strong>Import backups</strong> and pick your local
				<code class="font-mono text-xs">screen-time-backups</code> folder. Everything is parsed in your
				browser; only the derived daily totals are uploaded.
			</p>
		</div>
	{:else}
		<!-- filters -->
		<div class="flex flex-wrap items-center gap-2">
			<Select.Root type="single" bind:value={rangeDays}>
				<Select.Trigger>
					{rangeDays === 'all' ? 'All time' : `Last ${rangeDays} days`}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="7">Last 7 days</Select.Item>
					<Select.Item value="30">Last 30 days</Select.Item>
					<Select.Item value="90">Last 90 days</Select.Item>
					<Select.Item value="all">All time</Select.Item>
				</Select.Content>
			</Select.Root>

			<Select.Root type="single" bind:value={source}>
				<Select.Trigger>
					{source === 'infocus'
						? 'Focus events (all devices)'
						: source === 'screentime'
							? 'Screen Time (apps + websites)'
							: 'knowledgeC (Mac)'}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="infocus">Focus events (all devices)</Select.Item>
					<Select.Item value="screentime">Screen Time (apps + websites)</Select.Item>
					<Select.Item value="knowledgec">knowledgeC (Mac)</Select.Item>
				</Select.Content>
			</Select.Root>

			{#if source === 'screentime'}
				<Select.Root type="single" bind:value={stView}>
					<Select.Trigger>{stView === 'apps' ? 'Apps' : 'Websites'}</Select.Trigger>
					<Select.Content>
						<Select.Item value="apps">Apps</Select.Item>
						<Select.Item value="websites">Websites</Select.Item>
					</Select.Content>
				</Select.Root>
			{/if}

			{#each deviceIds as id (id)}
				<Button
					variant="outline"
					size="sm"
					class={excludedDevices.includes(id) ? 'opacity-45' : ''}
					onclick={() =>
						(excludedDevices = excludedDevices.includes(id)
							? excludedDevices.filter((d) => d !== id)
							: [...excludedDevices, id])}
				>
					<span
						class="size-2 rounded-full {excludedDevices.includes(id)
							? 'bg-muted-foreground'
							: 'bg-chart-1'}"
					></span>
					{deviceLabel(id)}
				</Button>
			{/each}

			<div class="ml-auto flex items-center gap-2">
				<label for="watchlist" class="text-xs whitespace-nowrap text-muted-foreground">
					Watchlist
				</label>
				<Input id="watchlist" class="h-8 w-52" bind:value={watchlistText} />
			</div>
		</div>

		<!-- KPIs -->
		{#if kpis}
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
				<StatTile
					label="Screen time this week"
					value={formatDuration(kpis.thisWeek)}
					delta={delta(kpis.thisWeek, kpis.priorWeek)}
					deltaGood={kpis.thisWeek <= kpis.priorWeek}
				/>
				<StatTile
					label="Watchlist this week"
					value={formatDuration(kpis.watchWeek)}
					delta={delta(kpis.watchWeek, kpis.watchPrior)}
					deltaGood={kpis.watchWeek <= kpis.watchPrior}
				/>
				<StatTile
					label="Daily average (range)"
					value={formatDuration(
						stacked.dates.length > 0
							? rows.reduce((a, r) => a + r.seconds, 0) / stacked.dates.length
							: 0
					)}
				/>
			</div>
		{/if}

		<!-- main chart -->
		<section class="rounded-lg border bg-card p-4 sm:p-6">
			<div class="mb-3 flex items-center justify-between gap-3">
				<h2 class="text-sm font-medium">Daily usage by app</h2>
				<Button variant="ghost" size="sm" onclick={() => (showTable = !showTable)}>
					{#if showTable}<IconChartBar size={16} />Chart{:else}<IconTable size={16} />Table{/if}
				</Button>
			</div>
			{#if showTable}
				<DataTable data={stacked} labelFor={appName} />
			{:else}
				<StackedChart data={stacked} kind="stacked-bar" labelFor={appName} />
			{/if}
		</section>

		<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
			<section class="rounded-lg border bg-card p-4 sm:p-6">
				<h2 class="mb-3 text-sm font-medium">Watchlist trend · 7-day average</h2>
				<StackedChart data={watchTrend} kind="line" labelFor={appName} />
			</section>

			<section class="rounded-lg border bg-card p-4 sm:p-6">
				<h2 class="mb-3 text-sm font-medium">Top apps in range</h2>
				<TopAppsList apps={ranked} />
			</section>
		</div>

		<p class="text-xs text-muted-foreground">
			Last import {new Date(cache.importedAt).toLocaleString()} · time zone {cache.timeZone} · sources
			are separate lenses and never summed together.
		</p>
	{/if}
</div>

{#if scan && (importState === 'labeling' || importState === 'uploading')}
	<ImportDialog
		open={true}
		{scan}
		initialLabels={cache?.devices ?? {}}
		uploading={importState === 'uploading'}
		onConfirm={confirmImport}
		onCancel={() => {
			scan = null;
			importState = 'idle';
		}}
	/>
{/if}
