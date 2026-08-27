<script lang="ts">
	import { onMount } from 'svelte';
	import {
		IconFolderOpen,
		IconTable,
		IconChartBar,
		IconAdjustmentsHorizontal
	} from '@tabler/icons-svelte';
	import Seo from '$lib/components/seo.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Select from '$lib/components/ui/select';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import StackedChart from '$lib/components/StackedChart.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import TopAppsList from '$lib/components/TopAppsList.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import ImportDialog from '$lib/components/ImportDialog.svelte';
	import DayGrid from '$lib/components/DayGrid.svelte';
	import type { UsageCache } from '$lib/data/cache';
	import type { ImportResult } from '$lib/import/importer';
	import {
		filterRows,
		dailyByApp,
		topApps,
		electUsage,
		combineUsage,
		dayGridCells
	} from '$lib/viz/series';
	import { appName, formatDuration } from '$lib/viz/format';

	let cache = $state<UsageCache | null>(null);
	let loading = $state(true);
	let importState: 'idle' | 'scanning' | 'labeling' | 'uploading' = $state('idle');
	let importProgress = $state('');
	let importError = $state('');
	let scan = $state<ImportResult | null>(null);

	let rangeDays = $state('90');
	// Apps and websites are parallel breakdowns of the same minutes. Combined
	// swaps browsers for their domains (no double counting); the pure views
	// show one breakdown at a time.
	let view = $state<'combined' | 'apps' | 'websites'>('combined');
	let excludedDevices: string[] = $state([]);
	// Explicitly picked chart series per view (empty = auto top-8).
	let picked = $state<{ combined: string[]; apps: string[]; websites: string[] }>({
		combined: [],
		apps: [],
		websites: []
	});
	let showTable = $state(false);

	onMount(async () => {
		try {
			picked = JSON.parse(localStorage.getItem('screentime:picked') ?? '') ?? picked;
		} catch {
			/* first run */
		}
		const res = await fetch('/api/usage');
		if (res.ok) cache = (await res.json()) as UsageCache;
		loading = false;
	});

	$effect(() => localStorage.setItem('screentime:picked', JSON.stringify(picked)));

	const deviceLabel = (id: string): string => cache?.devices[id] ?? id.slice(0, 8);

	// Collapse the measurement pipelines: per (device label, day) the best
	// available source wins, so nothing is ever double-counted.
	const elected = $derived(cache ? electUsage(cache.rows, deviceLabel) : { apps: [], webs: [] });
	const deviceLabels = $derived(
		[...new Set([...elected.apps, ...elected.webs].map((r) => deviceLabel(r.device)))].sort()
	);
	const byDevice = (rs: typeof elected.apps): typeof elected.apps =>
		rs.filter((r) => !excludedDevices.includes(deviceLabel(r.device)));
	const appsDev = $derived(byDevice(elected.apps));
	const websDev = $derived(byDevice(elected.webs));
	const sourceRows = $derived(
		view === 'combined' ? combineUsage(appsDev, websDev) : view === 'apps' ? appsDev : websDev
	);
	const lastDate = $derived(
		appsDev.length > 0 ? appsDev.reduce((m, r) => (r.date > m ? r.date : m), '') : ''
	);
	const startDate = $derived(
		rangeDays === 'all' || lastDate === ''
			? undefined
			: new Date(Date.parse(lastDate) - (Number(rangeDays) - 1) * 86_400_000)
					.toISOString()
					.slice(0, 10)
	);
	const rows = $derived(filterRows(sourceRows, { startDate, endDate: lastDate || undefined }));

	// 8 named series = every validated palette slot; the rest folds to Other in
	// the chart (picked series override the auto top-8); the ranked list below
	// shows everything.
	const stacked = $derived(dailyByApp(rows, 8, appName, picked[view]));
	const ranked = $derived(topApps(rows, Infinity, appName));
	// Day-rhythm grid: per-hour focus data, device-filtered, on the chart's axis.
	const hourlyRows = $derived(
		(cache?.hourly ?? []).filter(
			(h) =>
				!excludedDevices.includes(deviceLabel(h.device)) &&
				(!startDate || h.date >= startDate) &&
				(!lastDate || h.date <= lastDate)
		)
	);
	const gridCells = $derived(dayGridCells(hourlyRows, stacked.dates, appName));
	const namedKeys = $derived(stacked.series.map((s) => s.key).filter((k) => k !== 'Other'));

	const pickCandidates = $derived(ranked.slice(0, 30).map((t) => t.bundleId));
	function togglePick(key: string): void {
		const current = picked[view];
		picked = {
			...picked,
			[view]: current.includes(key) ? current.filter((k) => k !== key) : [...current, key]
		};
	}

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

			<Select.Root type="single" bind:value={view}>
				<Select.Trigger>
					{view === 'combined'
						? 'Apps + websites'
						: view === 'apps'
							? 'Apps only'
							: 'Websites only'}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="combined">Apps + websites</Select.Item>
					<Select.Item value="apps">Apps only</Select.Item>
					<Select.Item value="websites">Websites only</Select.Item>
				</Select.Content>
			</Select.Root>

			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="outline" size="sm">
							<IconAdjustmentsHorizontal size={16} />
							{picked[view].length === 0 ? 'Series: auto' : `Series: ${picked[view].length} picked`}
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content class="max-h-96 overflow-y-auto">
					<DropdownMenu.Item
						onclick={() => (picked = { ...picked, [view]: [] })}
						disabled={picked[view].length === 0}
					>
						Auto (top 8)
					</DropdownMenu.Item>
					<DropdownMenu.Separator />
					{#each pickCandidates as key (key)}
						<DropdownMenu.CheckboxItem
							checked={picked[view].includes(key)}
							disabled={!picked[view].includes(key) && picked[view].length >= 8}
							closeOnSelect={false}
							onCheckedChange={() => togglePick(key)}
						>
							{key}
						</DropdownMenu.CheckboxItem>
					{/each}
				</DropdownMenu.Content>
			</DropdownMenu.Root>

			{#each deviceLabels as label (label)}
				<Button
					variant="outline"
					size="sm"
					class={excludedDevices.includes(label) ? 'opacity-45' : ''}
					onclick={() =>
						(excludedDevices = excludedDevices.includes(label)
							? excludedDevices.filter((d) => d !== label)
							: [...excludedDevices, label])}
				>
					<span
						class="size-2 rounded-full {excludedDevices.includes(label)
							? 'bg-muted-foreground'
							: 'bg-chart-1'}"
					></span>
					{label}
				</Button>
			{/each}
		</div>

		<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
			<StatTile
				label="Daily average (range)"
				value={formatDuration(
					stacked.dates.length > 0
						? rows.reduce((a, r) => a + r.seconds, 0) / stacked.dates.length
						: 0
				)}
			/>
		</div>

		<!-- main chart -->
		<section class="rounded-lg border bg-card p-4 sm:p-6">
			<div class="mb-3 flex items-center justify-between gap-3">
				<h2 class="text-sm font-medium">Daily usage by app</h2>
				<Button variant="ghost" size="sm" onclick={() => (showTable = !showTable)}>
					{#if showTable}<IconChartBar size={16} />Chart{:else}<IconTable size={16} />Table{/if}
				</Button>
			</div>
			{#if showTable}
				<DataTable data={stacked} />
			{:else}
				<StackedChart data={stacked} kind="stacked-bar" />
			{/if}
		</section>

		<section class="rounded-lg border bg-card p-4 sm:p-6">
			<h2 class="mb-1 text-sm font-medium">Day rhythm</h2>
			<p class="mb-3 text-xs text-muted-foreground">
				Hour of day × date - each cell is that hour's dominant app, in the chart's colors; blank is
				screen off. Hover for the hour's breakdown.
			</p>
			{#if hourlyRows.length > 0}
				<DayGrid dates={stacked.dates} cells={gridCells} {namedKeys} />
			{:else}
				<p class="py-6 text-center text-sm text-muted-foreground">
					No per-hour data in this cache yet - run Import backups again to add it.
				</p>
			{/if}
		</section>

		<div class="grid grid-cols-1 gap-6">
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
