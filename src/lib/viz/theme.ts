// Runtime bridge: chart colors come from the CSS tokens in layout.css, so
// Chart.js always paints with the palette the current theme resolved.

export interface ChartTheme {
	series: string[];
	otherGray: string;
	surface: string;
	ink: string;
	mutedInk: string;
	gridline: string;
}

export function readChartTheme(): ChartTheme {
	const style = getComputedStyle(document.documentElement);
	const token = (name: string): string => style.getPropertyValue(name).trim();
	return {
		series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => token(`--chart-${i}`)),
		otherGray: token('--muted-foreground'),
		surface: token('--card'),
		ink: token('--foreground'),
		mutedInk: token('--muted-foreground'),
		gridline: token('--border')
	};
}
