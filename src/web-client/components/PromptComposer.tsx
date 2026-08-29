import { createSignal, Show } from 'solid-js'
import { enterAction, pastedImage, sendLabel } from '../utils/composer.ts'

type PromptComposerProps = {
	location?: string
	context?: string
	working?: boolean
	disabled?: boolean
	onSubmit: (text: string, queue: boolean) => Promise<boolean>
	onAttach: (file: File) => Promise<string>
}

// Append an attachment marker so it reads as part of the sentence: no double
// spaces before it, one trailing space so typing can continue right away.
function appendRef(value: string, path: string): string {
	const spacer = !value || /\s$/.test(value) ? '' : ' '
	return `${value}${spacer}[${path}] `
}

function hasCoarsePointer(): boolean {
	return window.matchMedia('(pointer: coarse)').matches
}

export function PromptComposer(props: PromptComposerProps) {
	let input: HTMLTextAreaElement | undefined
	let fileInput: HTMLInputElement | undefined
	const [attaching, setAttaching] = createSignal(false)

	// Grow with content up to a sane cap; past the cap the textarea scrolls.
	function autosize(): void {
		if (!input) return
		input.style.height = 'auto'
		input.style.height = `${Math.min(input.scrollHeight, 8 * 24)}px`
	}

	async function submit(queue = false): Promise<void> {
		if (props.disabled || attaching()) return
		const text = input?.value.trim() ?? ''
		if (!text || !input) return
		if (await props.onSubmit(text, queue)) {
			input.value = ''
			autosize()
		}
	}

	function onKeyDown(event: KeyboardEvent): void {
		const action = enterAction(event.key, { shift: event.shiftKey, coarse: hasCoarsePointer() })
		if (action === 'submit') {
			event.preventDefault()
			void submit()
		}
	}

	async function attach(file: File): Promise<void> {
		if (props.disabled || !input || attaching()) return
		setAttaching(true)
		try {
			const path = await props.onAttach(file)
			input.value = appendRef(input.value, path)
			autosize()
			input.focus()
		} catch (error) {
			alert(`Upload failed: ${error instanceof Error ? error.message : String(error)}`)
		} finally {
			setAttaching(false)
		}
	}

	function attachPickedFile(): void {
		const file = fileInput?.files?.[0]
		if (fileInput) fileInput.value = '' // allow re-picking the same file
		if (file) void attach(file)
	}

	function onPaste(event: ClipboardEvent): void {
		const file = pastedImage(event.clipboardData?.items ?? [])
		if (!file) return
		event.preventDefault()
		void attach(file)
	}

	// The execution details live beside the composer: the directory and model answer
	// "where and with what will this prompt run", while context remains visible even
	// when a long path has to truncate on a phone.
	return <form class={['PromptComposer', props.disabled && 'disabled']} aria-disabled={props.disabled ? 'true' : undefined} onSubmit={(event: SubmitEvent) => { event.preventDefault(); void submit() }}>
		<div class="PromptComposer-status">
			<span class="PromptComposer-location">{props.location}</span>
			<Show when={props.context}><span class="PromptComposer-context">{props.context}</span></Show>
		</div>
		<textarea
			ref={(element) => { input = element }}
			rows={1}
			autocomplete="off"
			placeholder="Message"
			disabled={props.disabled}
			onInput={autosize}
			onKeyDown={onKeyDown}
			onPaste={onPaste}
		/>
		<input ref={(element) => { fileInput = element }} type="file" accept="image/*" style="display: none" disabled={props.disabled} onChange={attachPickedFile} />
		<button type="button" class="PromptComposer-attach" disabled={attaching() || props.disabled} title="Attach image" onClick={() => fileInput?.click()}>📎</button>
		{/* Queue only exists while a turn runs: idle, sending already starts the
		    prompt immediately and a queue button would mean the same thing. */}
		<Show when={props.working}>
			<button type="button" disabled={attaching() || props.disabled} title="Run after the current turn" onClick={() => void submit(true)}>Queue</button>
		</Show>
		<button type="submit" disabled={attaching() || props.disabled}>{sendLabel(!!props.working)}</button>
	</form>
}
