<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { refreshMessage } from '$lib/viz/refresh-status';
	import { replaceState } from '$app/navigation';
	import { syncBackups, type SyncResult } from '$lib/import/incremental';
	import { filesToDir, querySqlite } from '$lib/import/browser';
	import {
		IconRefresh,
		IconBookmark,
		IconFlag,
		IconFolder,
		IconX,
		IconRotate,
		IconLoader2,
		IconEdit,
		IconTable,
		IconChartBar,
		IconClock,
		IconAdjustmentsHorizontal,
		IconApps,
		IconCalendarWeek,
		IconCalendarStats,
		IconChevronDown,
		IconDevices,
		IconKey,
		IconDeviceDesktop,
		IconDeviceLaptop,
		IconDeviceMobile
	} from '@tabler/icons-svelte';
	import { readSavedApps, isSavedAppsActive } from '$lib/viz/saved-apps';
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
	import MarkersDialog from '$lib/components/MarkersDialog.svelte';
	import type { Marker, MarkerInput } from '$lib/viz/markers';
	import type { UsageCache, FocusSession } from '$lib/data/cache';
	import type { RefreshStatus } from '$lib/server/store';
	import {
		filterRows,
		dailyByApp,
		topApps,
		appOptions,
		electUsage,
		combineUsage,
		bucketize,
		type Bucket
	} from '$lib/viz/series';
	import { appName, formatAverage, formatDuration } from '$lib/viz/format';
	import { makeDateParts } from '$lib/data/intervals';
	import {
		hourlyByApp,
		timelineByApp,
		sessionTime,
		combineHourlyUsage,
		withWebsiteHours
	} from '$lib/viz/rhythm';
	import { dateRange } from '$lib/viz/series';

	let cache = $state<UsageCache | null>(null);
	let loading = $state(true);
	let refresh = $state<RefreshStatus | null>(null);
	let refreshError = $state('');
	let devicesOpen = $state(false);
	let markersOpen = $state(false);
	let markers = $state<Marker[]>([]);
	let markersError = $state('');
	async function loadMarkers(): Promise<void> {
		const response = await fetch('/api/markers');
		if (!response.ok) throw new Error('Could not load markers');
		markers = ((await response.json()) as { markers: Marker[] }).markers;
	}
	async function saveMarker(marker: MarkerInput, id?: string): Promise<void> {
		const response = await fetch('/api/markers', {
			method: id ? 'PUT' : 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ...marker, id })
		});
		if (!response.ok) throw new Error('Could not save marker');
		await loadMarkers();
	}
	async function deleteMarker(id: string): Promise<void> {
		const response = await fetch('/api/markers?id=' + encodeURIComponent(id), { method: 'DELETE' });
		if (!response.ok) throw new Error('Could not delete marker');
		await loadMarkers();
	}
	let folderInput: HTMLInputElement;
	let localBusy = $state(false);
	let localProgress = $state('');
	let localResult = $state<SyncResult | null>(null);
	let localController = $state<AbortController | null>(null);

	async function importLocal(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		input.value = '';
		if (!files.length || localBusy) return;
		localBusy = true;
		localResult = null;
		localProgress = 'Checking local backups…';
		const controller = new AbortController();
		localController = controller;
		try {
			localResult = await syncBackups(filesToDir(files), {
				querySqlite,
				timeZone: cache?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
				signal: controller.signal,
				onProgress: (message) => (localProgress = message)
			});
		} catch (error) {
			localResult = { imported: 0, skipped: 0, failed: 0, errors: [String(error)] };
		} finally {
			// A failed or cancelled run may still have committed earlier files.
			try {
				await loadUsage();
			} catch (error) {
				if (localResult)
					localResult.errors = [...localResult.errors, `Could not reload usage: ${String(error)}`];
			}
			localBusy = false;
			localController = null;
		}
	}

	// Date range: a preset RULE ('90D'...) or '' = Custom, set by touching the
	// slider directly - same interplay as notion-task-burndown-chart.
	let activePreset = $state<string>('90D');
	let dateStart = $state('');
	let dateEnd = $state('');
	let excludedDevices: string[] = $state([]);
	// Time bucket: week/month bars show total usage per bucket.
	let bucket = $state<Bucket>('day');
	let view = $state<'totals' | 'timeline' | 'hourly'>('totals');
	const viewLabels = { totals: 'Totals', timeline: 'Timeline', hourly: 'By hour' };
	// Explicitly picked chart series (empty = every app).
	let picked = $state<string[]>([]);
	let savedApps = $state<string[]>([]);
	const savedAppsActive = $derived(isSavedAppsActive(picked, savedApps, excludedDevices, bucket));
	function toggleSavedApps() {
		picked = savedAppsActive ? [] : [...savedApps];
		excludedDevices = [];
		bucket = 'day';
	}
	let showTable = $state(false);
	let sessionData = $state<{ key: string; sessions: FocusSession[] } | null>(null);
	let sessionError = $state('');
	let sessionAttempt = $state(0);
	let timelinePage = $state(0);
	const sessionKey = $derived(`${cache?.importedAt}|${dateStart}|${dateEnd}`);
	const shiftedWebsiteHours = $derived.by(() => {
		const parts = makeDateParts(cache?.timeZone ?? 'UTC');
		return (cache?.websiteHours ?? []).some((w) => parts(w.startMs).msIntoDay % 3_600_000 !== 0);
	});
	const needsSessions = $derived(view === 'timeline' || (view === 'hourly' && shiftedWebsiteHours));
	$effect(() => {
		const key = sessionKey;
		void sessionAttempt;
		if (!needsSessions || !cache || !dateStart || !dateEnd || sessionData?.key === key) return;
		const controller = new AbortController();
		sessionError = '';
		fetch(`/api/usage?${new URLSearchParams({ sessions: '1', start: dateStart, end: dateEnd })}`, {
			signal: controller.signal
		})
			.then(async (response) => {
				if (!response.ok) throw Error(`Session request failed (${response.status})`);
				return response.json() as Promise<{ sessions: FocusSession[] }>;
			})
			.then((data) => {
				if (!controller.signal.aborted) sessionData = { key, sessions: data.sessions };
			})
			.catch((error) => {
				if (!controller.signal.aborted) sessionError = String(error);
			});
		return () => controller.abort();
	});

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
				savedApps?: string[];
				view?: string;
				showTable?: boolean;
			};
			picked = readSavedApps(p.picked, []);
			savedApps = readSavedApps(p.savedApps, picked);
			bucket = p.bucket === 'week' || p.bucket === 'month' ? p.bucket : 'day';
			view = p.view === 'timeline' || p.view === 'hourly' ? p.view : 'totals';
			showTable = p.showTable === true;
			excludedDevices = readSavedApps(p.excludedDevices, []);
			activePreset =
				p.preset === '' || PRESET_LABELS.includes(p.preset as PresetLabel) ? p.preset! : '90D';
			if (p.preset === '' && p.dateStart && p.dateEnd) {
				dateStart = p.dateStart;
				dateEnd = p.dateEnd;
			}
		} catch {
			/* first run */
		}
		const setup = new URL(location.href);
		if (setup.searchParams.has('saveApps')) {
			try {
				const apps = readSavedApps(JSON.parse(setup.searchParams.get('saveApps')!), []);
				if (apps.length) {
					savedApps = apps;
					picked = [...apps];
					excludedDevices = [];
					bucket = 'day';
				}
			} catch {
				/* malformed setup link leaves preferences intact */
			}
			setup.searchParams.delete('saveApps');
		}
		try {
			await loadUsage();
		} catch (error) {
			refreshError = String(error);
		}
		loading = false;
		if (location.search.includes('saveApps=')) replaceState(setup, {});
		try {
			await loadMarkers();
		} catch (error) {
			markersError = String(error);
		}
		// A refresh in flight from before a reload keeps being watched.
		try {
			await loadRefresh();
		} catch (error) {
			refreshError = String(error);
		}
		watchRefresh();
	});

	async function loadUsage(): Promise<void> {
		const res = await fetch('/api/usage');
		if (res.status === 404) {
			cache = null;
			return;
		}
		if (!res.ok) throw new Error(`Usage request failed (${res.status})`);
		cache = (await res.json()) as UsageCache;
	}
	async function loadRefresh(): Promise<void> {
		const res = await fetch('/api/refresh');
		if (!res.ok) throw new Error(`Refresh status failed (${res.status})`);
		refresh = (await res.json()) as RefreshStatus;
		now = Date.now();
	}

	// Refresh = ask the mac mini (via the Worker's flag) for a fresh dump +
	// incremental import, then poll until the run completes or fails.
	const refreshBusy = $derived(
		refresh?.phase !== 'failed' && (refresh?.pending === true || refresh?.phase === 'running')
	);
	let watching = false;
	let watchVersion = 0;
	let refreshTimer: ReturnType<typeof setTimeout>;
	let disposed = false;
	onDestroy(() => {
		disposed = true;
		clearTimeout(refreshTimer);
		localController?.abort();
	});
	async function requestRefresh(kind: 'dump' | 'rebuild', retry = false): Promise<void> {
		refreshError = '';
		try {
			const res = await fetch('/api/refresh', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ kind, retry })
			});
			if (!res.ok) throw new Error(`Refresh request failed (${res.status})`);
			refresh = (await res.json()) as RefreshStatus;
			now = Date.now();
			watchRefresh(true);
		} catch (error) {
			refreshError = String(error);
		}
	}
	function watchRefresh(restart = false): void {
		if (watching && !restart) return;
		clearTimeout(refreshTimer);
		watching = true;
		const version = ++watchVersion;
		const tick = async (): Promise<void> => {
			if (disposed || version !== watchVersion) return;
			if (document.hidden) {
				refreshTimer = setTimeout(tick, 30_000);
				return;
			}
			const previous = refresh;
			try {
				await loadRefresh();
				if (disposed || version !== watchVersion) return;
				refreshError = '';
			} catch (error) {
				if (disposed || version !== watchVersion) return;
				refreshError = `Could not confirm refresh progress: ${String(error)}`;
				if (refresh) refresh = { ...refresh, confirmed: false };
				refreshTimer = setTimeout(tick, 15_000);
				return;
			}
			if (refreshBusy) {
				if (!disposed) refreshTimer = setTimeout(tick, 5000);
				return;
			}
			if (refresh?.phase === 'failed' && refresh.stage !== 'retrying')
				refreshError = refresh.error ?? 'refresh failed';
			else if (refresh?.phase === 'idle') refreshError = '';
			// A mini run can commit some files before failing on a later file.
			try {
				if (
					!previous ||
					previous.phase !== refresh?.phase ||
					previous.importedAt !== refresh?.importedAt
				)
					await loadUsage();
			} catch (error) {
				refreshError = [refreshError, `Could not reload usage: ${String(error)}`]
					.filter(Boolean)
					.join(' · ');
			}
			if (disposed || version !== watchVersion) return;
			if (!refresh || refresh.phase === 'failed') {
				refreshTimer = setTimeout(tick, 15000);
				return;
			}
			if (!disposed) refreshTimer = setTimeout(tick, 30_000);
		};
		refreshTimer = setTimeout(tick, 3000);
	}
	let now = $state(Date.now());
	$effect(() => {
		if (!refreshBusy && refresh?.stage !== 'retrying') return;
		const id = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(id);
	});
	const refreshHint = $derived(refreshMessage(refresh, now));
	const canRetry = $derived(
		refresh?.phase === 'failed' ||
			(refresh?.phase === 'requested' && now - Date.parse(refresh.requestedAt!) > 60_000) ||
			(refresh?.phase === 'running' && refresh.pending)
	);
	onMount(() => {
		let resuming = false;
		const resume = async () => {
			if (document.hidden || disposed || resuming) return;
			resuming = true;
			try {
				await loadRefresh();
				await loadUsage();
			} catch (error) {
				refreshError = `Could not reload dashboard: ${String(error)}`;
			} finally {
				resuming = false;
			}
			if (!disposed) {
				watchRefresh(true);
			}
		};
		document.addEventListener('visibilitychange', resume);
		window.addEventListener('focus', resume);
		return () => {
			document.removeEventListener('visibilitychange', resume);
			window.removeEventListener('focus', resume);
		};
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
			JSON.stringify({
				preset: activePreset,
				dateStart,
				dateEnd,
				bucket,
				excludedDevices,
				picked,
				savedApps,
				view,
				showTable
			})
		)
	);

	const deviceLabel = (id: string): string => cache?.devices[id] ?? id.slice(0, 8);

	// Collapse the measurement pipelines: per (device label, day) the best
	// available source wins, so nothing is ever double-counted.
	const elected = $derived(cache ? electUsage(cache.rows, deviceLabel) : { apps: [], webs: [] });
	const deviceLabels = $derived(
		[
			...new Set(
				[
					...elected.apps,
					...elected.webs,
					...(cache?.websiteHours ?? []),
					...(cache?.hourly ?? []),
					...(cache?.sessions ?? [])
				].map((r) => deviceLabel(r.device))
			)
		].sort()
	);
	const selectedDevices = $derived(deviceLabels.filter((l) => !excludedDevices.includes(l)));
	const deviceIcon = (label: string): typeof IconDeviceDesktop =>
		/iphone|phone|ios/i.test(label)
			? IconDeviceMobile
			: /book|laptop|air/i.test(label)
				? IconDeviceLaptop
				: IconDeviceDesktop;
	const byDevice = <T extends { device: string }>(rs: T[]): T[] =>
		rs.filter((r) => !excludedDevices.includes(deviceLabel(r.device)));
	const appsDev = $derived(byDevice(elected.apps));
	const websDev = $derived(byDevice(elected.webs));
	// Apps and websites live in ONE stack: browsers scaled down to the residual
	// not covered by their tracked domains, so nothing double-counts.
	const sourceRows = $derived(
		combineUsage(appsDev, websDev, (r) => `${deviceLabel(r.device)}|${r.date}`)
	);
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

	const totalRows = $derived(
		filterRows(sourceRows, {
			startDate: dateStart || undefined,
			endDate: dateEnd || undefined
		})
	);
	const hourRows = $derived(
		filterRows(
			combineHourlyUsage(
				byDevice(cache?.hourly ?? []),
				byDevice(cache?.websiteHours ?? []),
				cache?.timeZone ?? 'UTC',
				deviceLabel,
				shiftedWebsiteHours && sessionData?.key === sessionKey
					? byDevice(sessionData.sessions)
					: undefined
			),
			{
				startDate: dateStart || undefined,
				endDate: dateEnd || undefined
			}
		)
	);
	const timedUsage = $derived(
		withWebsiteHours(
			byDevice(sessionData?.key === sessionKey ? sessionData.sessions : []),
			byDevice(cache?.websiteHours ?? []),
			deviceLabel
		)
	);
	const timeline = $derived(
		view === 'timeline'
			? timelineByApp(timedUsage, cache?.timeZone ?? 'UTC', dateStart, dateEnd, bucket, appName)
			: undefined
	);
	const rows = $derived(
		view === 'totals'
			? totalRows
			: view === 'hourly'
				? hourRows.map((r) => ({ ...r, source: 'infocus' as const }))
				: (timeline?.points ?? []).map((p) => ({
						source: 'infocus' as const,
						device: p.device,
						date: p.date,
						bundleId: p.bundleId,
						seconds: p.seconds
					}))
	);
	const filteredTimeline = $derived(
		timeline && picked.length
			? timelineByApp(
					timedUsage,
					cache?.timeZone ?? 'UTC',
					dateStart,
					dateEnd,
					bucket,
					appName,
					picked
				)
			: timeline
	);
	$effect(() => {
		void filteredTimeline;
		timelinePage = 0;
	});

	// Every app is its own series (picks act as a filter).
	const stacked = $derived(dailyByApp(rows, appName, picked));
	const bucketed = $derived(
		view === 'hourly'
			? hourlyByApp(hourRows, appName, picked)
			: view === 'timeline'
				? { dates: timeline?.dates ?? [], series: [] }
				: bucketize(stacked, bucket)
	);
	// Overall daily average across EVERYTHING currently filtered (apps picked,
	// devices, date range), over the days the range spans.
	const totalSeconds = $derived(
		rows
			.filter((r) => !picked.length || picked.includes(appName(r.bundleId)))
			.reduce((sum, r) => sum + r.seconds, 0)
	);
	const avgPerDay = $derived(totalSeconds / Math.max(1, dateRange(dateStart, dateEnd).length));
	const ranked = $derived(topApps(rows, Infinity, appName));
	const candidates = $derived(
		appOptions(
			totalRows,
			hourRows.map((r) => ({ ...r, source: 'infocus' as const })),
			rows,
			appName
		)
	);
	// Display key -> raw bundle id, for App Store icon lookups in the chart.
	const rawFor = $derived(Object.fromEntries(candidates.map((t) => [t.bundleId, t.raw])));

	// Every app in range is selectable; the search box makes the long tail
	// reachable. Picked entries stay listed even when they don't match, so a
	// search can never hide what's currently on the chart.
	let pickQuery = $state('');
	const pickCandidates = $derived(
		candidates.filter(
			(t) =>
				picked.includes(t.bundleId) ||
				t.bundleId.toLowerCase().includes(pickQuery.trim().toLowerCase())
		)
	);
	function togglePick(key: string): void {
		picked = picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key];
	}
	function toggleLegend(key: string): void {
		picked = (picked.length ? picked : ranked.map((r) => r.bundleId)).filter((k) => k !== key);
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
			<div class="flex flex-wrap items-center justify-end gap-2">
				<input
					bind:this={folderInput}
					type="file"
					webkitdirectory
					multiple
					class="hidden"
					aria-label="Choose backup folder"
					onchange={importLocal}
					oncancel={() => {
						localProgress = 'Folder selection cancelled.';
						localResult = null;
					}}
				/>
				<Button
					variant="outline"
					size="sm"
					disabled={localBusy || refreshBusy}
					onclick={() => folderInput.click()}
					title="Import dated snapshots from a local backup folder"
				>
					<IconFolder size={16} /> Import local
				</Button>
				{#if localBusy}
					<Button
						variant="outline"
						size="sm"
						disabled={localController?.signal.aborted}
						onclick={() => {
							localController?.abort();
							localProgress = 'Cancelling import…';
						}}
					>
						<IconX size={16} /> Cancel
					</Button>
				{/if}
				<Button variant="outline" size="sm" onclick={() => (markersOpen = true)}
					><IconFlag size={16} /> Markers</Button
				>
				{#if cache}
					<Button variant="ghost" size="sm" onclick={() => (devicesOpen = true)}>
						<IconEdit size={16} />
						Devices
					</Button>
				{/if}
				<Button variant="ghost" size="sm" href="/connect"
					><IconKey size={16} />Upload devices</Button
				>
				{#if cache}
					<Button
						variant="outline"
						size="sm"
						onclick={() => requestRefresh('rebuild')}
						disabled={refresh?.phase === 'running' || localBusy}
						title="Re-parse the snapshots already on disk (no new Screen Time dump)"
					>
						<IconRotate size={16} />
						Rebuild
					</Button>
				{/if}
				<Button
					onclick={() => requestRefresh('dump')}
					disabled={refresh?.phase === 'running' || localBusy}
					title="Take a fresh Screen Time dump on the mini, then import new files"
				>
					{#if refreshBusy}
						<IconLoader2 size={18} class="animate-spin" />
					{:else}
						<IconRefresh size={18} />
					{/if}
					Refresh
				</Button>
			</div>
			{#if refreshHint}
				<p role="status" class="max-w-xl text-xs text-muted-foreground tabular-nums">
					{refreshHint}
				</p>
			{/if}
			{#if canRetry}
				<Button
					variant="outline"
					size="sm"
					onclick={() => requestRefresh(refresh?.kind ?? 'dump', true)}
				>
					<IconRefresh size={16} /> Retry refresh
				</Button>
			{/if}
		</div>
	</header>

	{#if refreshError}
		<p class="text-sm text-destructive">{refreshError}</p>
	{/if}

	{#if markersError}<p class="text-sm text-destructive">{markersError}</p>{/if}
	{#if localProgress || localResult}
		<div class="min-w-0 rounded-lg border bg-card p-4 text-sm" role="status" aria-live="polite">
			{#if localBusy}
				<p class="flex items-center gap-2">
					<IconLoader2 size={16} class="shrink-0 animate-spin" /><span class="break-all"
						>{localProgress}</span
					>
				</p>
			{:else if localResult}
				<p>
					{localResult.imported} imported, {localResult.skipped} skipped, {localResult.failed} failed.
				</p>
			{:else}
				<p>{localProgress}</p>
			{/if}
			{#if localResult?.errors.length}
				<ul class="mt-2 max-h-64 list-disc space-y-1 overflow-y-auto pl-5 text-destructive">
					{#each localResult.errors as error}<li class="break-all">{error}</li>{/each}
				</ul>
			{/if}
		</div>
	{/if}

	{#if loading}
		<p class="py-24 text-center text-sm text-muted-foreground">Loading…</p>
	{:else if !cache}
		<div class="flex flex-col items-center gap-3 rounded-lg border bg-card px-6 py-20 text-center">
			<IconChartBar size={40} class="text-muted-foreground" />
			<h2 class="text-lg font-medium">No data yet</h2>
			<p class="max-w-md text-sm text-muted-foreground">
				Hit <strong>Refresh</strong>: the mac mini takes a fresh Screen Time dump and imports new or
				changed backup files. Or choose
				<strong>Import local</strong> to read a backup folder on this device.
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

			<Select.Root
				type="single"
				value={bucket}
				onValueChange={(v) => (bucket = v as Bucket)}
				disabled={view === 'hourly'}
			>
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

			<Select.Root type="single" value={view} onValueChange={(v) => (view = v as typeof view)}>
				<Select.Trigger aria-label="Chart view"
					><IconClock size={16} class="text-muted-foreground" />{viewLabels[view]}</Select.Trigger
				>
				<Select.Content>
					<Select.Item value="totals" label="Totals" />
					<Select.Item value="timeline" label="Timeline" />
					<Select.Item value="hourly" label="By hour" />
				</Select.Content>
			</Select.Root>

			<Button
				variant={savedAppsActive ? 'default' : 'outline'}
				size="sm"
				disabled={savedApps.length === 0}
				aria-pressed={savedAppsActive}
				title="Saved apps and websites, all devices, daily. Click again to show all apps."
				onclick={toggleSavedApps}
			>
				<IconBookmark size={16} /> Saved apps
			</Button>
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
							placeholder="Search {candidates.length} apps & sites"
							class="h-8"
							onkeydown={(e: KeyboardEvent) => {
								if (e.key !== 'Escape') e.stopPropagation();
							}}
						/>
					</div>
					{#if view !== 'totals'}
						<p class="px-2 py-1 text-xs text-muted-foreground">
							{#if view === 'timeline' && sessionData?.key !== sessionKey}
								{sessionError
									? 'Session history could not load. Daily totals are shown below.'
									: 'Loading time-of-day detail. Daily totals are shown below.'}
							{:else}
								Gray entries retain their daily totals. Time-of-day detail is unavailable in this
								view.
							{/if}
						</p>
						<DropdownMenu.Item onclick={() => (view = 'totals')}
							>Show daily totals</DropdownMenu.Item
						>
						<DropdownMenu.Separator />
					{/if}
					<DropdownMenu.Item
						disabled={picked.length === 0}
						onclick={() => {
							savedApps = [...picked];
							excludedDevices = [];
							bucket = 'day';
						}}>Save selection as preset</DropdownMenu.Item
					>
					{#if picked.length > 0}
						<DropdownMenu.Item onclick={() => (picked = [])}>Clear selection</DropdownMenu.Item>
						<DropdownMenu.Separator />
					{/if}
					{#each pickCandidates as t (t.bundleId)}
						{@const icon = iconUrl(t.bundleId, t.raw)}
						<DropdownMenu.CheckboxItem
							disabled={!t.available}
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
							<span class="min-w-0 flex-1 break-all">
								{t.bundleId}
								{#if !t.available && t.seconds !== null}
									<span class="block text-xs text-muted-foreground">
										{view === 'timeline' && sessionData?.key !== sessionKey
											? sessionError
												? 'Daily total · timing failed'
												: 'Daily total · timing loading'
											: 'Daily total'}
									</span>
								{/if}
							</span>
							<span class="text-xs text-muted-foreground tabular-nums">
								{t.seconds === null ? 'Unavailable' : formatDuration(t.seconds)}
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
				onValueChange={(v) =>
					(excludedDevices = v.length ? deviceLabels.filter((l) => !v.includes(l)) : [])}
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
			<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
				<div class="flex flex-wrap items-baseline gap-3">
					<h2 class="text-sm font-medium">
						{view === 'timeline'
							? 'When apps and sites were used'
							: view === 'hourly'
								? 'Usage by hour of day'
								: bucket === 'day'
									? 'Daily usage by app'
									: bucket === 'week'
										? 'Weekly usage by app'
										: 'Monthly usage by app'}
					</h2>
					<span class="text-xs text-muted-foreground tabular-nums">
						{view === 'totals'
							? formatAverage(avgPerDay, bucket)
							: `${formatDuration(totalSeconds)} total`}
					</span>
				</div>
				<Button variant="ghost" size="sm" onclick={() => (showTable = !showTable)}>
					{#if showTable}<IconChartBar size={16} />Chart{:else}<IconTable size={16} />Table{/if}
				</Button>
			</div>
			{#if view !== 'totals'}
				<p class="mb-3 text-xs text-muted-foreground">
					{view === 'timeline'
						? 'Solid bars show app sessions. Hatched blocks show hour totals at the recorded window’s starting hour; exact start/stop times are unavailable. Hover or open Table for durations.'
						: 'Total app and website usage by hour across the selected dates. Website totals use their recorded hour’s start time.'}
					{cache.timeZone}. Browser overlap is removed where timing is known. Daily-only history is
					omitted; capped or inferred app sessions are marked estimated.
				</p>
			{/if}
			{#if view === 'hourly' && hourRows.some((r) => r.overlapUnknown && (!picked.length || picked.includes(appName(r.bundleId))))}
				<p class="mb-3 text-xs text-muted-foreground">
					Some retained browser totals lack session detail. Their website overlap is unknown, so the
					combined total can count that time twice.
				</p>
			{/if}
			{#if needsSessions && sessionError}
				<p class="py-8 text-sm text-destructive" role="alert">{sessionError}</p>
				<Button
					variant="outline"
					size="sm"
					onclick={() => {
						sessionAttempt++;
					}}>Retry session history</Button
				>
			{:else if needsSessions && sessionData?.key !== sessionKey}
				<p class="py-16 text-center text-sm text-muted-foreground" role="status">
					Loading session history…
				</p>
			{:else if view !== 'totals' && totalSeconds === 0}
				<p class="py-16 text-center text-sm text-muted-foreground" role="status">
					No {view === 'timeline' ? 'session' : 'hourly'} history for these dates, devices, and apps.
				</p>
			{:else if showTable && filteredTimeline}
				<div class="max-h-96 overflow-auto rounded-lg border">
					<table class="w-full text-sm">
						<thead class="sticky top-0 bg-secondary"
							><tr
								>{#each ['Date', 'Time', 'App', 'Device', 'Duration'] as heading}<th
										class="px-3 py-2 text-left font-medium">{heading}</th
									>{/each}</tr
							></thead
						>
						<tbody
							>{#each filteredTimeline.points.slice(timelinePage * 100, (timelinePage + 1) * 100) as point}<tr
									class="border-t"
									><td class="px-3 py-2 whitespace-nowrap">{point.date}</td><td
										class="px-3 py-2 whitespace-nowrap"
										>{sessionTime(point.startMs, cache.timeZone)} - {sessionTime(
											point.endMs,
											cache.timeZone
										)}</td
									><td class="px-3 py-2">{point.key}</td><td class="px-3 py-2"
										>{deviceLabel(point.device)}</td
									><td class="px-3 py-2 whitespace-nowrap"
										>{formatDuration(point.seconds)}{point.resolution === 'hour'
											? ' · hour total'
											: point.estimated
												? ' · estimated'
												: ''}</td
									></tr
								>{/each}</tbody
						>
					</table>
				</div>
				<div
					class="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
				>
					<span
						>{timelinePage * 100 + 1}-{Math.min(
							(timelinePage + 1) * 100,
							filteredTimeline.points.length
						)} of {filteredTimeline.points.length} intervals, split at hour boundaries</span
					>
					<div class="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={timelinePage === 0}
							onclick={() => timelinePage--}>Previous</Button
						><Button
							variant="outline"
							size="sm"
							disabled={(timelinePage + 1) * 100 >= filteredTimeline.points.length}
							onclick={() => timelinePage++}>Next</Button
						>
					</div>
				</div>
			{:else if showTable}
				<DataTable data={bucketed} hourly={view === 'hourly'} />
			{:else}
				<StackedChart
					data={bucketed}
					kind="stacked-bar"
					{bucket}
					{rawFor}
					hourly={view === 'hourly'}
					timeline={filteredTimeline}
					{deviceLabel}
					timeZone={cache.timeZone}
					onToggle={toggleLegend}
					markers={markers.filter((m) => m.date >= dateStart && m.date <= dateEnd)}
				/>
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

{#if markersOpen}
	<MarkersDialog
		open={true}
		{markers}
		onSave={saveMarker}
		onDelete={deleteMarker}
		onClose={() => (markersOpen = false)}
	/>
{/if}
