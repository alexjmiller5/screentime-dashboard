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
		scan.focusEventsByDevice[id]?.length ?? scan.knowledgecSessionsByDevice[id]?.length ?? 0;

	// Devices with no events carry no data - don't ask about them.
	const deviceIds = $derived(
		[
			...Object.keys(scan.focusEventsByDevice),
			...Object.keys(scan.knowledgecSessionsByDevice)
		].filter((id) => eventCount(id) > 0)
	);

	// Prefill: prior label > platform guess from the events (suffixed with the
	// short uuid when two devices guess alike) > short uuid.
	let labels: Record<string, string> = $state({});
	$effect(() => {
		const guessed = new Set<string>();
		labels = Object.fromEntries(
			deviceIds.map((id) => {
				if (initialLabels[id]) return [id, initialLabels[id]];
				if (id === 'knowledgec') return [id, 'Mac (knowledgeC)'];
				const guess = guessDeviceLabel(scan.focusEventsByDevice[id] ?? []);
				if (guess === null) return [id, id.slice(0, 8)];
				const label = guessed.has(guess) ? `${guess} (${id.slice(0, 8)})` : guess;
				guessed.add(guess);
				return [id, label];
			})
		);
	});
</script>

<Dialog.Root {open} onOpenChange={(o) => !o && onCancel()}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Name your devices</Dialog.Title>
			<Dialog.Description>
				Scanned {scan.snapshots.length} snapshots. Give each discovered device a label - it's how they'll
				appear in the charts.
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
