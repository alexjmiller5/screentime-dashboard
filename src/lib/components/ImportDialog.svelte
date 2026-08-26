<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import type { ImportResult } from '$lib/import/importer';
	import { guessDeviceLabel } from '$lib/import/paths';

	interface Props {
		open: boolean;
		scan: ImportResult;
		/** Existing labels from the previous cache, prefilled. */
		initialLabels: Record<string, string>;
		uploading: boolean;
		onConfirm: (labels: Record<string, string>) => void;
		onCancel: () => void;
	}
	const { open, scan, initialLabels, uploading, onConfirm, onCancel }: Props = $props();

	const eventCount = (id: string): number =>
		scan.focusEventsByDevice[id]?.length ??
		scan.knowledgecSessionsByDevice[id]?.length ??
		scan.deviceActivityByDevice[id]?.length ??
		0;

	// Devices with no events carry no data - don't ask about them.
	const deviceIds = $derived(
		[
			...new Set([
				...Object.keys(scan.focusEventsByDevice),
				...Object.keys(scan.knowledgecSessionsByDevice),
				...Object.keys(scan.deviceActivityByDevice)
			])
		].filter((id) => eventCount(id) > 0)
	);

	// Machine-generated labels (uuid prefixes, suffixed guesses, the old
	// knowledgeC default) were never the user's words - don't let them shadow
	// a fresh platform guess. Plain "iPhone"/"Mac"/anything typed stays.
	const isPlaceholder = (label: string, id: string): boolean =>
		label.toUpperCase() === id.slice(0, 8).toUpperCase() ||
		/^(iPhone|Mac) \([0-9A-F]{8}\)$/i.test(label) ||
		label === 'Mac (knowledgeC)';

	// For Screen Time devices there are no focus events - guess from the
	// bundle ids in their activity entries instead.
	const guessEvents = (id: string): { tsMs: number; bundleId: string; focus: boolean }[] =>
		scan.focusEventsByDevice[id] ??
		(scan.deviceActivityByDevice[id] ?? []).flatMap((segment) =>
			segment.entries
				.filter((e) => !e.key.startsWith('web:'))
				.map((e) => ({ tsMs: 0, bundleId: e.key, focus: true }))
		);

	// Prefill: real prior label > platform guess > short uuid. Entries sharing
	// a name merge, so same-guess entries share the prefill deliberately -
	// "iPhone" twice IS one iPhone. Only "Mac" gets uuid suffixes past the
	// first, because several physical Macs are likely (rename to merge/split).
	let labels: Record<string, string> = $state({});
	$effect(() => {
		let macs = 0;
		labels = Object.fromEntries(
			deviceIds.map((id) => {
				const prior = initialLabels[id];
				if (prior && !isPlaceholder(prior, id)) return [id, prior];
				if (id === 'knowledgec') return [id, 'Mac']; // same physical Mac -> same name
				const guess = guessDeviceLabel(guessEvents(id));
				if (guess === null) return [id, id.slice(0, 8)];
				if (guess === 'Mac' && ++macs > 1) return [id, `Mac (${id.slice(0, 8)})`];
				return [id, guess];
			})
		);
	});
</script>

<Dialog.Root {open} onOpenChange={(o) => !o && onCancel()}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Name your devices</Dialog.Title>
			<Dialog.Description>
				Scanned {scan.snapshots.length} snapshots. Name each entry after its physical device. Entries
				sharing a name are merged (the best data source wins per day) - the same device appears more than
				once because Apple uses different ids per subsystem, so name both "iPhone", and name the knowledgeC
				entry after your Mac (e.g. "MacBook").
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-3">
			{#each deviceIds as id (id)}
				<div class="flex flex-col gap-1">
					<Label for="dev-{id}" class="font-mono text-xs text-muted-foreground">
						{id} · {eventCount(id).toLocaleString()} events
					</Label>
					<Input id="dev-{id}" bind:value={labels[id]} />
				</div>
			{/each}
			{#if scan.errors.length > 0}
				<p class="text-xs text-destructive">
					{scan.errors.length} snapshot(s) skipped: {scan.errors.join('; ')}
				</p>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={onCancel} disabled={uploading}>Cancel</Button>
			<Button onclick={() => onConfirm(labels)} disabled={uploading}>
				{uploading ? 'Uploading…' : 'Upload to dashboard'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
