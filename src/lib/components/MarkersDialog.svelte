<script lang="ts">
	import { IconPencil, IconTrash, IconPlus } from '@tabler/icons-svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { parseMarker, MARKER_TITLE_MAX, type Marker, type MarkerInput } from '$lib/viz/markers';

	interface Props {
		open: boolean;
		markers: Marker[];
		/** Persist one marker and update the parent's list before resolving. */
		onSave: (marker: MarkerInput, id?: string) => Promise<void>;
		onDelete: (id: string) => Promise<void>;
		onClose: () => void;
	}
	const { open, markers, onSave, onDelete, onClose }: Props = $props();
	let editing = $state<string | undefined>();
	let date = $state('');
	let title = $state('');
	let saving = $state(false);
	let error = $state('');
	let status = $state('');
	let dateInput = $state<HTMLInputElement | null>(null);

	function reset() {
		editing = undefined;
		date = '';
		title = '';
		error = '';
	}
	$effect(() => {
		if (open) {
			reset();
			status = '';
		}
	});

	async function save(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		saving = true;
		try {
			await onSave(parseMarker({ date, title }), editing);
			status = editing ? 'Marker updated.' : 'Marker added.';
			reset();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}
	async function remove(id: string) {
		error = '';
		saving = true;
		try {
			await onDelete(id);
			if (editing === id) reset();
			status = 'Marker deleted.';
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}
	function edit(marker: Marker) {
		editing = marker.id;
		date = marker.date;
		title = marker.title;
		error = '';
		status = '';
		dateInput?.focus();
	}
</script>

<Dialog.Root {open} onOpenChange={(value) => !value && !saving && onClose()}>
	<Dialog.Content class="max-h-[90dvh] overflow-y-auto sm:max-w-lg" showCloseButton={!saving}>
		<Dialog.Header>
			<Dialog.Title>Screen Time markers</Dialog.Title>
			<Dialog.Description>Add dated events to give changes in usage context.</Dialog.Description>
		</Dialog.Header>
		<form class="flex flex-col gap-3" onsubmit={save}>
			<div class="flex flex-col gap-1">
				<Label for="marker-date">Date</Label>
				<Input
					id="marker-date"
					type="date"
					min="0001-01-01"
					max="9999-12-31"
					required
					bind:ref={dateInput}
					bind:value={date}
					disabled={saving}
				/>
			</div>
			<div class="flex flex-col gap-1">
				<Label for="marker-title">Title</Label>
				<Input
					id="marker-title"
					required
					maxlength={MARKER_TITLE_MAX}
					bind:value={title}
					disabled={saving}
					placeholder="Event title"
				/>
			</div>
			<div class="flex flex-wrap gap-2">
				<Button type="submit" disabled={saving}
					>{#if !editing}<IconPlus class="size-4" />{/if}{saving
						? 'Saving…'
						: editing
							? 'Save changes'
							: 'Add marker'}</Button
				>
				{#if editing}<Button type="button" variant="outline" onclick={reset} disabled={saving}
						>Cancel edit</Button
					>{/if}
			</div>
		</form>
		{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
		<p role="status" class="sr-only">{status}</p>
		<ul class="flex max-h-[35dvh] flex-col divide-y overflow-y-auto" aria-label="Saved markers">
			{#each [...markers].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title)) as marker (marker.id)}
				<li class="flex items-center gap-2 py-2">
					<div class="min-w-0 flex-1">
						<p class="text-sm break-words">{marker.title}</p>
						<time class="text-xs text-muted-foreground" datetime={marker.date}>{marker.date}</time>
					</div>
					<Button
						size="icon-sm"
						variant="ghost"
						disabled={saving}
						onclick={() => edit(marker)}
						aria-label={`Edit ${marker.title}`}><IconPencil class="size-4" /></Button
					>
					<Button
						size="icon-sm"
						variant="ghost"
						disabled={saving}
						onclick={() => remove(marker.id)}
						aria-label={`Delete ${marker.title}`}><IconTrash class="size-4" /></Button
					>
				</li>
			{:else}<li class="py-2 text-sm text-muted-foreground">No markers yet.</li>{/each}
		</ul>
		<Dialog.Footer
			><Button variant="outline" onclick={onClose} disabled={saving}>Done</Button></Dialog.Footer
		>
	</Dialog.Content>
</Dialog.Root>
