import { createSignal, Show } from 'solid-js'
import { enterAction, sendLabel } from '../utils/composer.ts'

type PromptComposerProps = {
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
		if (props.disabled) return
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

	async function attach(): Promise<void> {
		if (props.disabled) return
		const file = fileInput?.files?.[0]
		if (!file || !input || !fileInput) return
		fileInput.value = '' // allow re-picking the same file
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

	return <form class={['PromptComposer', props.disabled && 'disabled']} aria-disabled={props.disabled ? 'true' : undefined} onSubmit={(event: SubmitEvent) => { event.preventDefault(); void submit() }}>
		<textarea
			ref={(element) => { input = element }}
			rows={1}
			autocomplete="off"
			placeholder="Message"
			disabled={props.disabled}
			onInput={autosize}
			onKeyDown={onKeyDown}
		/>
		<input ref={(element) => { fileInput = element }} type="file" accept="image/*" style="display: none" disabled={props.disabled} onChange={attach} />
		<button type="button" class="PromptComposer-attach" disabled={attaching() || props.disabled} title="Attach image" onClick={() => fileInput?.click()}>📎</button>
		{/* Queue only exists while a turn runs: idle, sending already starts the
		    prompt immediately and a queue button would mean the same thing. */}
		<Show when={props.working}>
			<button type="button" disabled={attaching() || props.disabled} title="Run after the current turn" onClick={() => void submit(true)}>Queue</button>
		</Show>
		<button type="submit" disabled={attaching() || props.disabled}>{sendLabel(!!props.working)}</button>
	</form>
}
