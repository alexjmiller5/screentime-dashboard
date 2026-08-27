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
		Tooltip,
		Legend,
		Filler
	} from 'chart.js';
	import type { StackedSeries } from '$lib/viz/series';
	import { readChartTheme } from '$lib/viz/theme';
	import { formatDuration } from '$lib/viz/format';

	Chart.register(
		BarController,
		BarElement,
		LineController,
		LineElement,
		PointElement,
		CategoryScale,
		LinearScale,
		Tooltip,
		Legend,
		Filler
	);

	interface Props {
		data: StackedSeries;
		kind: 'stacked-bar' | 'line';
		/** Series label prettifier (bundle id -> app name). */
		labelFor?: (key: string) => string;
	}
	const { data, kind, labelFor = (k) => k }: Props = $props();

	let canvas: HTMLCanvasElement;
	let chart: Chart | null = null;

	function render(): void {
		if (!canvas) return;
		chart?.destroy();
		const theme = readChartTheme();
		const color = (key: string, i: number): string =>
			key === 'Other' ? theme.otherGray : theme.series[i % theme.series.length];

		chart = new Chart(canvas, {
			type: kind === 'stacked-bar' ? 'bar' : 'line',
			data: {
				labels: data.dates,
				datasets: data.series.map((s, i) => ({
					label: labelFor(s.key),
					data: s.data.map((v) => v / 3600),
					...(kind === 'stacked-bar'
						? {
								backgroundColor: color(s.key, i),
								// the dataviz surface gap: neighbors separated by surface, not strokes
								borderColor: theme.surface,
								borderWidth: { top: 2, right: 0, bottom: 0, left: 0 },
								borderRadius: 3,
								borderSkipped: false as const,
								maxBarThickness: 24
							}
						: {
								borderColor: color(s.key, i),
								backgroundColor: color(s.key, i),
								borderWidth: 2,
								pointRadius: 0,
								pointHoverRadius: 5,
								pointBorderColor: theme.surface,
								pointBorderWidth: 2,
								tension: 0.25
							})
				}))
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				interaction: { mode: 'index', intersect: false },
				scales: {
					x: {
						stacked: kind === 'stacked-bar',
						grid: { display: false },
						border: { color: theme.gridline },
						ticks: {
							color: theme.mutedInk,
							maxRotation: 0,
							autoSkip: true,
							maxTicksLimit: 10,
							font: { size: 11 }
						}
					},
					y: {
						stacked: kind === 'stacked-bar',
						beginAtZero: true,
						grid: { color: theme.gridline, lineWidth: 1 },
						border: { display: false },
						ticks: {
							color: theme.mutedInk,
							font: { size: 11 },
							callback: (value) => `${value}h`
						}
					}
				},
				plugins: {
					legend: {
						display: data.series.length > 1,
						position: 'bottom',
						labels: {
							color: theme.ink,
							boxWidth: 10,
							boxHeight: 10,
							borderRadius: 2,
							useBorderRadius: true,
							font: { size: 12 }
						}
					},
					tooltip: {
						backgroundColor: theme.surface,
						titleColor: theme.ink,
						bodyColor: theme.ink,
						borderColor: theme.gridline,
						borderWidth: 1,
						padding: 10,
						callbacks: {
							label: (item) =>
								`${item.dataset.label}: ${formatDuration((item.parsed.y ?? 0) * 3600)}`,
							// The Other fold stays inspectable: hovering a day appends its
							// largest folded constituents.
							afterBody: (items) => {
								const other = items.find((i) => i.dataset.label === 'Other');
								const detail = other && data.otherTop?.[other.dataIndex];
								if (!detail || detail.length === 0) return [];
								return [
									'',
									'Other:',
									...detail.map((o) => `  ${o.key}: ${formatDuration(o.seconds)}`)
								];
							}
						}
					}
				}
			}
		});
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
