<script lang="ts">
	import { onMount } from 'svelte';
	import {
		IconFolderOpen,
		IconTable,
		IconChartBar,
		IconAdjustmentsHorizontal,
		IconApps,
		IconCalendarWeek,
		IconCalendarStats,
		IconChevronDown,
		IconDevices,
		IconDeviceDesktop,
		IconDeviceLaptop,
		IconDeviceMobile
	} from '@tabler/icons-svelte';
	import { iconUrl } from '$lib/viz/icons.svelte';
	import RangeSlider from '$lib/components/RangeSlider.svelte';
	import { PRESET_LABELS, getPresetRange, type PresetLabel } from '$lib/viz/presets';
	import Seo from '$lib/components/seo.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import StackedChart from '$lib/components/StackedChart.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import ImportDialog from '$lib/components/ImportDialog.svelte';
	import type { UsageCache } from '$lib/data/cache';
	import type { ImportResult } from '$lib/import/importer';
	import {
		filterRows,
		dailyByApp,
		topApps,
		electUsage,
		combineUsage,
		bucketize,
		type Bucket
	} from '$lib/viz/series';
	import { appName, formatAverage, formatDuration } from '$lib/viz/format';

	let cache = $state<UsageCache | null>(null);
	let loading = $state(true);
	let importState: 'idle' | 'scanning' | 'labeling' | 'uploading' = $state('idle');
	let importProgress = $state('');
	let importError = $state('');
	let scan = $state<ImportResult | null>(null);

	// Date range: a preset RULE ('90D'...) or '' = Custom, set by touching the
	// slider directly - same interplay as notion-task-burndown-chart.
	let activePreset = $state<string>('90D');
	let dateStart = $state('');
	let dateEnd = $state('');
	let excludedDevices: string[] = $state([]);
	// Time bucket: week/month bars show AVERAGE daily usage per bucket.
	let bucket = $state<Bucket>('day');
	// Explicitly picked chart series (empty = every app).
	let picked = $state<string[]>([]);
	let showTable = $state(false);

	// All filter selections persist across reloads (like the burndown chart).
	// A stored PRESET is a rule - it re-anchors to the fresh data bounds via
	// the preset effect below; a stored Custom range restores its literal dates.
	const PREFS_KEY = 'screentime:prefs';
	onMount(async () => {
		try {
			const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '') as {
				preset?: string;
				dateStart?: string;
				dateEnd?: string;
				bucket?: Bucket;
				excludedDevices?: string[];
				picked?: string[];
			};
			picked = p.picked ?? [];
			bucket = p.bucket ?? 'day';
			excludedDevices = p.excludedDevices ?? [];
			activePreset = p.preset ?? '90D';
			if (p.preset === '' && p.dateStart && p.dateEnd) {
				dateStart = p.dateStart;
				dateEnd = p.dateEnd;
			}
		} catch {
			/* first run */
		}
		const res = await fetch('/api/usage');
		if (res.ok) cache = (await res.json()) as UsageCache;
		loading = false;
	});

	$effect(() =>
		localStorage.setItem(
			PREFS_KEY,
			JSON.stringify({ preset: activePreset, dateStart, dateEnd, bucket, excludedDevices, picked })
		)
	);

	const deviceLabel = (id: string): string => cache?.devices[id] ?? id.slice(0, 8);

	// Collapse the measurement pipelines: per (device label, day) the best
	// available source wins, so nothing is ever double-counted.
	const elected = $derived(cache ? electUsage(cache.rows, deviceLabel) : { apps: [], webs: [] });
	const deviceLabels = $derived(
		[...new Set([...elected.apps, ...elected.webs].map((r) => deviceLabel(r.device)))].sort()
	);
	const selectedDevices = $derived(deviceLabels.filter((l) => !excludedDevices.includes(l)));
	const deviceIcon = (label: string): typeof IconDeviceDesktop =>
		/iphone|phone|ios/i.test(label)
			? IconDeviceMobile
			: /book|laptop|air/i.test(label)
				? IconDeviceLaptop
				: IconDeviceDesktop;
	const byDevice = (rs: typeof elected.apps): typeof elected.apps =>
		rs.filter((r) => !excludedDevices.includes(deviceLabel(r.device)));
	const appsDev = $derived(byDevice(elected.apps));
	const websDev = $derived(byDevice(elected.webs));
	// Apps and websites live in ONE stack: browsers scaled down to the residual
	// not covered by their tracked domains, so nothing double-counts.
	const sourceRows = $derived(combineUsage(appsDev, websDev));
	// Slider bounds: the full extent of the data, before any device filter.
	const bounds = $derived.by(() => {
		let min = '';
		let max = '';
		for (const r of [...elected.apps, ...elected.webs]) {
			if (!min || r.date < min) min = r.date;
			if (r.date > max) max = r.date;
		}
		return { min, max };
	});

	// A preset is a rule: it (re)computes the concrete range whenever the data
	// bounds land or the preset changes. Custom ('') leaves the dates alone.
	$effect(() => {
		if (activePreset && bounds.max) {
			const range = getPresetRange(activePreset as PresetLabel, bounds.min, bounds.max);
			dateStart = range.start;
			dateEnd = range.end;
		}
	});

	function handleSliderChange(start: string, end: string): void {
		activePreset = '';
		dateStart = start;
		dateEnd = end;
	}

	// A restored Custom range can fall outside fresh data bounds (the backup
	// window slides weekly) - clamp what the slider displays.
	const sliderStart = $derived(!dateStart || dateStart < bounds.min ? bounds.min : dateStart);
	const sliderEnd = $derived(!dateEnd || dateEnd > bounds.max ? bounds.max : dateEnd);

	const rows = $derived(
		filterRows(sourceRows, {
			startDate: dateStart || undefined,
			endDate: dateEnd || undefined
		})
	);

	// Every app is its own series (picks act as a filter).
	const stacked = $derived(dailyByApp(rows, appName, picked));
	const bucketed = $derived(bucketize(stacked, bucket));
	// Overall daily average across EVERYTHING currently filtered (apps picked,
	// devices, date range), over the days the range spans.
	const avgPerDay = $derived(
		stacked.dates.length > 0
			? rows
					.filter((r) => picked.length === 0 || picked.includes(appName(r.bundleId)))
					.reduce((a, r) => a + r.seconds, 0) / stacked.dates.length
			: 0
	);
	const ranked = $derived(topApps(rows, Infinity, appName));
	// Display key -> raw bundle id, for App Store icon lookups in the chart.
	const rawFor = $derived(Object.fromEntries(ranked.map((t) => [t.bundleId, t.raw])));

	// Every app in range is selectable; the search box makes the long tail
	// reachable. Picked entries stay listed even when they don't match, so a
	// search can never hide what's currently on the chart.
	let pickQuery = $state('');
	const pickCandidates = $derived(
		ranked.filter(
			(t) =>
				picked.includes(t.bundleId) ||
				t.bundleId.toLowerCase().includes(pickQuery.trim().toLowerCase())
		)
	);
	function togglePick(key: string): void {
		picked = picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key];
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
			<Select.Root type="single" bind:value={activePreset}>
				<Select.Trigger>
					<IconCalendarWeek size={16} class="text-muted-foreground" />
					{activePreset === '' ? 'Custom' : activePreset}
				</Select.Trigger>
				<Select.Content>
					{#each PRESET_LABELS as label (label)}
						<Select.Item value={label} {label} />
					{/each}
				</Select.Content>
			</Select.Root>

			<Select.Root type="single" value={bucket} onValueChange={(v) => (bucket = v as Bucket)}>
				<Select.Trigger>
					<IconCalendarStats size={16} class="text-muted-foreground" />
					{bucket === 'day' ? 'Daily' : bucket === 'week' ? 'Weekly avg' : 'Monthly avg'}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="day" label="Daily" />
					<Select.Item value="week" label="Weekly avg" />
					<Select.Item value="month" label="Monthly avg" />
				</Select.Content>
			</Select.Root>

			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="outline" size="sm" class="font-normal">
							<IconAdjustmentsHorizontal size={16} class="text-muted-foreground" />
							{picked.length === 0
								? 'Filter apps & sites'
								: `Showing ${picked.length} app${picked.length === 1 ? '' : 's'}`}
							<IconChevronDown size={16} class="text-muted-foreground" />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content class="max-h-96 w-80 overflow-y-auto">
					<div class="sticky top-0 z-10 -mx-1 -mt-1 mb-1 bg-popover px-1 pt-1 pb-1">
						<Input
							bind:value={pickQuery}
							placeholder="Search {ranked.length} apps & sites"
							class="h-8"
							onkeydown={(e: KeyboardEvent) => e.stopPropagation()}
						/>
					</div>
					{#if picked.length > 0}
						<DropdownMenu.Item onclick={() => (picked = [])}>Clear selection</DropdownMenu.Item>
						<DropdownMenu.Separator />
					{/if}
					{#each pickCandidates as t (t.bundleId)}
						{@const icon = iconUrl(t.bundleId, t.raw)}
						<DropdownMenu.CheckboxItem
							checked={picked.includes(t.bundleId)}
							closeOnSelect={false}
							onCheckedChange={() => togglePick(t.bundleId)}
						>
							{#if icon}
								<img src={icon} alt="" loading="lazy" class="size-4 rounded-[3px]" />
							{:else}
								<IconApps size={16} class="text-muted-foreground" />
							{/if}
							<!-- full name (wraps, never truncates) + time in the selected range -->
							<span class="min-w-0 flex-1 break-all">{t.bundleId}</span>
							<span class="text-xs text-muted-foreground tabular-nums">
								{formatDuration(t.seconds)}
							</span>
						</DropdownMenu.CheckboxItem>
					{:else}
						<p class="px-2 py-3 text-center text-sm text-muted-foreground">No matches</p>
					{/each}
				</DropdownMenu.Content>
			</DropdownMenu.Root>

			<Select.Root
				type="multiple"
				value={selectedDevices}
				onValueChange={(v) => (excludedDevices = deviceLabels.filter((l) => !v.includes(l)))}
			>
				<Select.Trigger>
					<IconDevices size={16} class="text-muted-foreground" />
					{selectedDevices.length === deviceLabels.length
						? 'All devices'
						: `${selectedDevices.length} of ${deviceLabels.length} devices`}
				</Select.Trigger>
				<Select.Content>
					{#each deviceLabels as label (label)}
						{@const Icon = deviceIcon(label)}
						<Select.Item value={label}>
							<Icon size={16} class="text-muted-foreground" />
							{label}
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>

		<!-- date range slider: mirrors the preset select; dragging it directly
		     flips the preset to Custom -->
		{#if bounds.max}
			<div class="px-1">
				<RangeSlider
					min={bounds.min}
					max={bounds.max}
					start={sliderStart}
					end={sliderEnd}
					onchange={handleSliderChange}
				/>
			</div>
		{/if}

		<!-- main chart -->
		<section class="rounded-lg border bg-card p-4 sm:p-6">
			<div class="mb-3 flex items-center justify-between gap-3">
				<div class="flex items-baseline gap-3">
					<h2 class="text-sm font-medium">
						{bucket === 'day'
							? 'Daily usage by app'
							: bucket === 'week'
								? 'Weekly usage by app'
								: 'Monthly usage by app'}
					</h2>
					<span class="text-xs text-muted-foreground tabular-nums">
						{formatAverage(avgPerDay, bucket)}
					</span>
				</div>
				<Button variant="ghost" size="sm" onclick={() => (showTable = !showTable)}>
					{#if showTable}<IconChartBar size={16} />Chart{:else}<IconTable size={16} />Table{/if}
				</Button>
			</div>
			{#if showTable}
				<DataTable data={bucketed} />
			{:else}
				<StackedChart data={bucketed} kind="stacked-bar" {bucket} {rawFor} />
			{/if}
		</section>

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
