<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';

	interface Props {
		open: boolean;
		/** device id -> current label */
		devices: Record<string, string>;
		onSave: (labels: Record<string, string>) => Promise<void>;
		onClose: () => void;
	}
	const { open, devices, onSave, onClose }: Props = $props();

	let labels = $state<Record<string, string>>({});
	let saving = $state(false);
	let error = $state('');
	$effect(() => {
		labels = { ...devices };
	});

	async function save(): Promise<void> {
		saving = true;
		error = '';
		try {
			await onSave(labels);
			onClose();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root {open} onOpenChange={(o) => !o && onClose()}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Name your devices</Dialog.Title>
			<Dialog.Description>
				Apple uses a different id per subsystem, so one physical device can appear more than once.
				Entries sharing a name are merged (the best data source wins per day).
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
			{#each Object.keys(devices) as id (id)}
				<div class="flex flex-col gap-1">
					<Label for="dev-{id}" class="font-mono text-xs text-muted-foreground">{id}</Label>
					<Input id="dev-{id}" bind:value={labels[id]} />
				</div>
			{/each}
		</div>
		{#if error}<p class="text-xs text-destructive">{error}</p>{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={onClose} disabled={saving}>Cancel</Button>
			<Button onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
