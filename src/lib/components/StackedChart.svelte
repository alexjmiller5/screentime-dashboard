<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Chart,
		BarController,
		BarElement,
		LineController,
		LineElement,
		PointElement,
		CategoryScale,
		LinearScale,
		TimeScale,
		Tooltip,
		Legend,
		Filler,
		type ChartDataset
	} from 'chart.js';
	import 'chartjs-adapter-dayjs-4';
	import dayjs from 'dayjs';
	import type { StackedSeries, Bucket } from '$lib/viz/series';
	import { readChartTheme, type ChartTheme } from '$lib/viz/theme';
	import { appColor, paletteIndex, formatDuration } from '$lib/viz/format';
	import { iconUrl } from '$lib/viz/icons.svelte';

	Chart.register(
		BarController,
		BarElement,
		LineController,
		LineElement,
		PointElement,
		CategoryScale,
		LinearScale,
		TimeScale,
		Tooltip,
		Legend,
		Filler
	);

	interface Props {
		data: StackedSeries;
		kind: 'stacked-bar' | 'line';
		/** Time bucket the data arrived in - drives the x axis and tooltip titles. */
		bucket?: Bucket;
		/** Series label prettifier (bundle id -> app name). */
		labelFor?: (key: string) => string;
		/** Display key -> raw bundle id, for App Store icon lookup. */
		rawFor?: Record<string, string>;
	}
	const { data, kind, bucket = 'day', labelFor = (k) => k, rawFor = {} }: Props = $props();

	let canvas: HTMLCanvasElement;
	let chart: Chart | null = null;

	// Chart.js cost scales with DATASET count, not data volume: past this many
	// series, per-app datasets get quadratically slow (451 series took ~5s a
	// render). Above it we switch to rank-level floating bars - every app still
	// gets its own true segment, but datasets = max apps per day (~50).
	const MANY_SERIES = 30;

	// App icons as tiny canvases: Chart.js draws image point styles at their
	// natural size, so pre-render at legend size; repaint when the image lands.
	// Repaints coalesce into one rAF - hundreds of icons landing must not each
	// trigger a full chart update.
	const iconCanvases = new Map<string, HTMLCanvasElement>();
	let repaintQueued = false;
	function scheduleRepaint(): void {
		if (repaintQueued) return;
		repaintQueued = true;
		requestAnimationFrame(() => {
			repaintQueued = false;
			chart?.update('none');
		});
	}
	function iconCanvas(url: string): HTMLCanvasElement {
		let c = iconCanvases.get(url);
		if (c) return c;
		c = document.createElement('canvas');
		c.width = 14;
		c.height = 14;
		iconCanvases.set(url, c);
		const img = new Image();
		img.onload = () => {
			c!.getContext('2d')?.drawImage(img, 0, 0, 14, 14);
			scheduleRepaint();
		};
		img.src = url;
		return c;
	}
	const pointStyle = (key: string): HTMLCanvasElement | 'rectRounded' => {
		const url = iconUrl(key, rawFor[key] ?? key);
		return url ? iconCanvas(url) : 'rectRounded';
	};

	// Day/week keep a continuous time axis with week-anchored 'MMM D' ticks;
	// month labels each bar 'MMM YYYY' - same scheme as the burndown chart, so
	// the axis reads nicely for any range/bucket combination.
	function xScale(theme: ChartTheme, stacked: boolean) {
		const common = {
			stacked,
			grid: { display: false },
			border: { color: theme.gridline },
			ticks: {
				color: theme.mutedInk,
				maxRotation: 0,
				autoSkip: true,
				maxTicksLimit: 10,
				font: { size: 11 }
			}
		};
		if (bucket === 'month') {
			return {
				...common,
				type: 'category' as const,
				ticks: {
					...common.ticks,
					callback(this: { getLabelForValue(v: number): string }, value: number) {
						return dayjs(this.getLabelForValue(value)).format('MMM YYYY');
					}
				}
			};
		}
		return {
			...common,
			type: 'time' as const,
			offset: true,
			time: {
				unit: 'week' as const,
				displayFormats: { day: 'MMM D', week: 'MMM D', month: 'MMM YYYY' }
			}
		};
	}

	function scaleOptions(theme: ChartTheme, stacked: boolean) {
		return {
			x: xScale(theme, stacked),
			y: {
				stacked,
				beginAtZero: true,
				grid: { color: theme.gridline, lineWidth: 1 },
				border: { display: false },
				ticks: {
					color: theme.mutedInk,
					font: { size: 11 },
					callback: (value: string | number) => `${value}h`
				}
			}
		};
	}

	// Bucket-appropriate tooltip title from the ORIGINAL label (the time axis
	// would otherwise render a verbose datetime).
	const tooltipTitle = (items: { dataIndex: number }[]): string => {
		const raw = data.dates[items[0]?.dataIndex ?? -1];
		if (!raw) return '';
		if (bucket === 'month') return dayjs(raw).format('MMMM YYYY');
		if (bucket === 'week') return `Week of ${dayjs(raw).format('MMM D, YYYY')}`;
		return dayjs(raw).format('ddd, MMM D, YYYY');
	};

	function tooltipBase(theme: ChartTheme) {
		return {
			usePointStyle: true, // app icons beside tooltip rows
			backgroundColor: theme.surface,
			titleColor: theme.ink,
			bodyColor: theme.ink,
			footerColor: theme.mutedInk,
			footerFont: { weight: 'normal' as const },
			borderColor: theme.gridline,
			borderWidth: 1,
			padding: 10
		};
	}

	const barStyle = (theme: ChartTheme) => ({
		// the dataviz surface gap: neighbors separated by surface, not strokes
		borderColor: theme.surface,
		borderWidth: { top: 2, right: 0, bottom: 0, left: 0 },
		borderRadius: 3,
		borderSkipped: false as const,
		maxBarThickness: 24
	});

	/** One dataset per app - legend with icons, entity-stable colors. */
	function perAppConfig(theme: ChartTheme, color: (key: string) => string) {
		return {
			type: (kind === 'stacked-bar' ? 'bar' : 'line') as 'bar',
			data: {
				labels: data.dates,
				datasets: data.series.map((s) => ({
					label: labelFor(s.key),
					// Zero days become null so unused apps draw nothing that day.
					// (Never skipNull: it turns stacking quadratic in dataset count.)
					data: s.data.map((v) => (v > 0 ? v / 3600 : null)),
					pointStyle: pointStyle(s.key),
					...(kind === 'stacked-bar'
						? { backgroundColor: color(s.key), ...barStyle(theme) }
						: {
								borderColor: color(s.key),
								backgroundColor: color(s.key),
								borderWidth: 2,
								pointRadius: 0,
								pointHoverRadius: 5,
								pointBorderColor: theme.surface,
								pointBorderWidth: 2,
								tension: 0.25
							})
				})) as ChartDataset<'bar'>[]
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false as const,
				interaction: { mode: 'index' as const, intersect: false },
				scales: scaleOptions(theme, kind === 'stacked-bar'),
				plugins: {
					legend: {
						display: data.series.length > 1,
						position: 'bottom' as const,
						labels: {
							color: theme.ink,
							usePointStyle: true, // app icons as legend markers
							pointStyleWidth: 16,
							boxHeight: 14,
							font: { size: 12 }
						}
					},
					tooltip: {
						...tooltipBase(theme),
						// Only the apps actually used that day, biggest first.
						filter: (item: { parsed: { y: number | null } }) => (item.parsed.y ?? 0) > 0,
						itemSort: (a: { parsed: { y: number | null } }, b: { parsed: { y: number | null } }) =>
							(b.parsed.y ?? 0) - (a.parsed.y ?? 0),
						callbacks: {
							title: tooltipTitle,
							label: (item: { dataset: { label?: string }; parsed: { y: number | null } }) =>
								`${item.dataset.label}: ${formatDuration((item.parsed.y ?? 0) * 3600)}`
						}
					}
				}
			}
		};
	}

	/** Rank-level floating bars: dataset k holds each day's k-th biggest app as
	 * an absolute [base, top] span with per-element color/label/icon. Every app
	 * keeps its own segment, but dataset count = deepest day, not app count. */
	function rankedConfig(theme: ChartTheme, color: (key: string) => string) {
		const n = data.dates.length;
		const perDay: { key: string; v: number }[][] = Array.from({ length: n }, () => []);
		for (const s of data.series) {
			s.data.forEach((v, i) => {
				if (v > 0) perDay[i].push({ key: s.key, v: v / 3600 });
			});
		}
		for (const day of perDay) day.sort((a, b) => b.v - a.v);
		const depth = perDay.reduce((m, day) => Math.max(m, day.length), 0);
		const keys: (string | null)[][] = Array.from({ length: depth }, () => Array(n).fill(null));
		const spans: ([number, number] | null)[][] = Array.from({ length: depth }, () =>
			Array(n).fill(null)
		);
		for (let i = 0; i < n; i++) {
			let base = 0;
			perDay[i].forEach((seg, k) => {
				keys[k][i] = seg.key;
				spans[k][i] = [base, base + seg.v];
				base += seg.v;
			});
		}
		const keyAt = (item: { datasetIndex: number; dataIndex: number }): string | null =>
			keys[item.datasetIndex]?.[item.dataIndex] ?? null;
		const spanOf = (item: { datasetIndex: number; dataIndex: number }): number => {
			const span = spans[item.datasetIndex]?.[item.dataIndex];
			return span ? span[1] - span[0] : 0;
		};

		return {
			type: 'bar' as const,
			data: {
				labels: data.dates,
				datasets: spans.map((span, k) => ({
					label: `#${k + 1}`,
					data: span as unknown as number[],
					grouped: false,
					backgroundColor: (ctx: { dataIndex: number }) => {
						const key = keys[k][ctx.dataIndex];
						return key ? color(key) : 'transparent';
					},
					...barStyle(theme),
					// Dozens of tiny segments per day: rounding every one reads as
					// confetti - only the day's outermost segment gets the radius.
					borderRadius: (ctx: { dataIndex: number }) => (keys[k + 1]?.[ctx.dataIndex] ? 0 : 3)
				})) as ChartDataset<'bar'>[]
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false as const,
				interaction: { mode: 'index' as const, intersect: false },
				// Floating bars carry absolute positions; no stacking pass needed.
				scales: scaleOptions(theme, false),
				plugins: {
					// No legend at this cardinality - hover carries identity.
					legend: { display: false },
					tooltip: {
						...tooltipBase(theme),
						// Ranks are already sorted: the first 15 datasets ARE the day's
						// top 15 apps; the footer accounts for the rest.
						filter: (item: { datasetIndex: number; dataIndex: number }) =>
							item.datasetIndex < 15 && keyAt(item) !== null,
						callbacks: {
							title: tooltipTitle,
							label: (item: { datasetIndex: number; dataIndex: number }) => {
								const key = keyAt(item);
								return key ? `${labelFor(key)}: ${formatDuration(spanOf(item) * 3600)}` : '';
							},
							footer: (items: { dataIndex: number }[]) => {
								const i = items[0]?.dataIndex;
								if (i === undefined) return '';
								const day = perDay[i];
								const total = day.reduce((a, s) => a + s.v, 0);
								const rest = day.length - 15;
								const totalLine = `${bucket === 'day' ? 'Total' : 'Avg/day'}: ${formatDuration(total * 3600)}`;
								return rest > 0 ? `+ ${rest} more\n${totalLine}` : totalLine;
							},
							labelColor: (item: { datasetIndex: number; dataIndex: number }) => {
								const key = keyAt(item);
								return {
									backgroundColor: key ? color(key) : 'transparent',
									borderColor: theme.surface
								};
							},
							labelPointStyle: (item: { datasetIndex: number; dataIndex: number }) => {
								const key = keyAt(item);
								return {
									pointStyle: key ? pointStyle(key) : ('rectRounded' as const),
									rotation: 0
								};
							}
						}
					}
				}
			}
		};
	}

	function render(): void {
		if (!canvas) return;
		chart?.destroy();
		const theme = readChartTheme();
		// Each series wears its app's brand color; unknown apps hash to a stable
		// token-palette slot so color follows the entity, never its rank.
		const color = (key: string): string => appColor(key) ?? theme.series[paletteIndex(key)];
		const config =
			kind === 'stacked-bar' && data.series.length > MANY_SERIES
				? rankedConfig(theme, color)
				: perAppConfig(theme, color);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		chart = new Chart(canvas, config as any);
	}

	onMount(() => () => chart?.destroy());
	$effect(() => {
		void data;
		void kind;
		render();
	});
</script>

<div class="relative h-[320px] w-full sm:h-[420px]">
	<canvas bind:this={canvas}></canvas>
</div>
