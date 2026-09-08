<script lang="ts">
	import { onMount } from 'svelte';
	import {
		IconRefresh,
		IconLoader2,
		IconEdit,
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
	import DevicesDialog from '$lib/components/DevicesDialog.svelte';
	import type { UsageCache } from '$lib/data/cache';
	import type { RefreshStatus } from '$lib/server/store';
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
	let refresh = $state<RefreshStatus | null>(null);
	let refreshError = $state('');
	let devicesOpen = $state(false);

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
		await loadUsage();
		loading = false;
		// A refresh in flight from before a reload keeps being watched.
		await loadRefresh();
		if (refresh?.pending || refresh?.phase === 'running') watchRefresh();
	});

	async function loadUsage(): Promise<void> {
		const res = await fetch('/api/usage');
		if (res.ok) cache = (await res.json()) as UsageCache;
	}
	async function loadRefresh(): Promise<void> {
		const res = await fetch('/api/refresh');
		if (res.ok) refresh = (await res.json()) as RefreshStatus;
	}

	// Refresh = ask the mac mini (via the Worker's flag) for a fresh dump +
	// rebuild, then poll until the import lands or fails.
	const refreshBusy = $derived(refresh?.pending === true || refresh?.phase === 'running');
	let watching = false;
	async function requestRefresh(): Promise<void> {
		refreshError = '';
		const res = await fetch('/api/refresh', { method: 'POST' });
		if (!res.ok) {
			refreshError = `refresh request failed (${res.status})`;
			return;
		}
		refresh = (await res.json()) as RefreshStatus;
		watchRefresh();
	}
	function watchRefresh(): void {
		if (watching) return;
		watching = true;
		const before = cache?.importedAt;
		const tick = async (): Promise<void> => {
			await loadRefresh();
			if (refresh?.phase === 'failed') {
				refreshError = refresh.error ?? 'refresh failed';
			} else if (refreshBusy) {
				setTimeout(tick, 5000);
				return;
			} else if (refresh?.importedAt && refresh.importedAt !== before) {
				await loadUsage();
			}
			watching = false;
		};
		setTimeout(tick, 3000);
	}
	const secondsSince = (iso?: string): number =>
		iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)) : 0;
	let now = $state(Date.now());
	$effect(() => {
		if (!refreshBusy) return;
		const id = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(id);
	});
	const refreshHint = $derived.by(() => {
		if (!refresh) return '';
		void now;
		if (refresh.phase === 'requested')
			return `Waiting for the mini to pick it up… ${secondsSince(refresh.requestedAt)}s`;
		if (refresh.phase === 'running')
			return `Rebuilding on the mini… ${secondsSince(refresh.startedAt)}s`;
		return '';
	});

	async function saveDevices(labels: Record<string, string>): Promise<void> {
		const res = await fetch('/api/devices', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(labels)
		});
		if (!res.ok) throw new Error(`save failed (${res.status})`);
		if (cache) cache = { ...cache, devices: labels };
	}

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
		<div class="flex flex-col items-end gap-1">
			<div class="flex items-center gap-2">
				{#if cache}
					<Button variant="ghost" size="sm" onclick={() => (devicesOpen = true)}>
						<IconEdit size={16} />
						Devices
					</Button>
				{/if}
				<Button onclick={requestRefresh} disabled={refreshBusy}>
					{#if refreshBusy}
						<IconLoader2 size={18} class="animate-spin" />
					{:else}
						<IconRefresh size={18} />
					{/if}
					Refresh
				</Button>
			</div>
			{#if refreshHint}
				<p class="text-xs text-muted-foreground tabular-nums">{refreshHint}</p>
			{/if}
		</div>
	</header>

	{#if refreshError}
		<p class="text-sm text-destructive">Refresh failed: {refreshError}</p>
	{/if}

	{#if loading}
		<p class="py-24 text-center text-sm text-muted-foreground">Loading…</p>
	{:else if !cache}
		<div class="flex flex-col items-center gap-3 rounded-lg border bg-card px-6 py-20 text-center">
			<IconChartBar size={40} class="text-muted-foreground" />
			<h2 class="text-lg font-medium">No data yet</h2>
			<p class="max-w-md text-sm text-muted-foreground">
				Hit <strong>Refresh</strong>: the mac mini takes a fresh Screen Time dump, rebuilds the
				daily series from every snapshot, and pushes them here.
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
					{bucket === 'day' ? 'Daily' : bucket === 'week' ? 'Weekly' : 'Monthly'}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="day" label="Daily" />
					<Select.Item value="week" label="Weekly" />
					<Select.Item value="month" label="Monthly" />
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
			Data through {bounds.max} · synced {new Date(cache.importedAt).toLocaleString()} · time zone
			{cache.timeZone} · sources are separate lenses and never summed together.
		</p>
	{/if}
</div>

{#if cache && devicesOpen}
	<DevicesDialog
		open={true}
		devices={cache.devices}
		onSave={saveDevices}
		onClose={() => (devicesOpen = false)}
	/>
{/if}
