import { createEffect, createSignal, onSettled, Show } from 'solid-js'
import { attachmentRef, enterAction, pastedImage, sendLabel, typingKey } from '../utils/composer.ts'
import { webDraft } from '../utils/draft.ts'

type PromptComposerProps = {
	sessionId: string
	location?: string
	context?: string
	activity: string
	working?: boolean
	disabled?: boolean
	onSubmit: (text: string, queue: boolean) => Promise<boolean>
	onAttach: (file: File) => Promise<string>
}

function hasCoarsePointer(): boolean {
	return window.matchMedia('(pointer: coarse)').matches
}

export function PromptComposer(props: PromptComposerProps) {
	let input: HTMLTextAreaElement | undefined
	let inputShell: HTMLDivElement | undefined
	let fileInput: HTMLInputElement | undefined
	const [attaching, setAttaching] = createSignal(false)
	const [draftDurable, setDraftDurable] = createSignal(true)

	// Measure the whole draft. CSS caps desktop height; focused phone editing
	// can use the remaining viewport before the textarea needs to scroll.
	function autosize(): void {
		if (!input || !inputShell) return
		inputShell.style.height = 'auto'
		input.style.height = 'auto'
		input.style.height = `${input.scrollHeight}px`
		inputShell.style.height = `${input.scrollHeight}px`
	}

	function saveDraft(): void {
		if (!input || !props.sessionId) return
		setDraftDurable(webDraft.save(props.sessionId, input.value))
		autosize()
	}

	// A route change swaps editors without unmounting the composer. Restore the
	// selected session here; a full reload follows the exact same path.
	createEffect(() => props.sessionId, (sessionId) => {
		if (!input) return
		input.value = sessionId ? webDraft.load(sessionId) : ''
		input.setSelectionRange(input.value.length, input.value.length)
		setDraftDurable(webDraft.isDurable())
		autosize()
	})

	// iOS can freeze or evict a backgrounded app without beforeunload. Input events
	// are the primary write path; these lifecycle events are the final safety net.
	onSettled(() => {
		const preserve = () => saveDraft()
		addEventListener('pagehide', preserve)
		document.addEventListener('visibilitychange', preserve)
		document.addEventListener('keydown', redirectKey)
		document.addEventListener('paste', redirectPaste)
		return () => {
			removeEventListener('pagehide', preserve)
			document.removeEventListener('visibilitychange', preserve)
			document.removeEventListener('keydown', redirectKey)
			document.removeEventListener('paste', redirectPaste)
		}
	})

	async function submit(queue = false): Promise<void> {
		if (props.disabled || attaching() || !input) return
		const sessionId = props.sessionId
		const draft = input.value
		const text = draft.trim()
		if (!text || !sessionId) return
		if (!await props.onSubmit(text, queue)) return

		const cleared = webDraft.clearIfUnchanged(sessionId, draft)
		setDraftDurable(webDraft.isDurable())
		if (cleared && props.sessionId === sessionId && input.value === draft) {
			input.value = ''
			autosize()
		}
	}

	function onKeyDown(event: KeyboardEvent): void {
		const action = enterAction(event.key, { shift: event.shiftKey, coarse: hasCoarsePointer(), meta: event.metaKey, ctrl: event.ctrlKey, working: !!props.working })
		if (action === 'submit' || action === 'queue') {
			event.preventDefault()
			void submit(action === 'queue')
		}
	}

	async function attach(file: File): Promise<void> {
		if (props.disabled || !input || attaching()) return
		const sessionId = props.sessionId
		const start = input.selectionStart
		const end = input.selectionEnd
		setAttaching(true)
		try {
			const path = await props.onAttach(file)
			if (props.sessionId !== sessionId) return
			input.setRangeText(attachmentRef(input.value, start, path), start, end, 'end')
			saveDraft()
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

	function redirectable(event: Event): boolean {
		if (!input || props.disabled || event.defaultPrevented || document.querySelector('dialog[open]')) return false
		return !(event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable], [role="textbox"]'))
	}

	function insert(text: string): void {
		if (!input) return
		input.focus()
		input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end')
		saveDraft()
	}

	function redirectKey(event: KeyboardEvent): void {
		if (!redirectable(event) || !typingKey(event)) return
		if (event.key === ' ' && event.target instanceof Element && event.target.closest('button, a, summary, [role="button"]')) return
		event.preventDefault()
		insert(event.key)
	}

	function redirectPaste(event: ClipboardEvent): void {
		if (!redirectable(event)) return
		const image = pastedImage(event.clipboardData?.items ?? [])
		const text = event.clipboardData?.getData('text/plain') ?? ''
		if (!image && !text) return
		event.preventDefault()
		if (image) {
			input?.focus()
			void attach(image)
		} else {
			insert(text)
		}
	}

	// Keep activity, execution location and context in the terminal-style status row.
	return <form class={['PromptComposer', props.disabled && 'disabled']} aria-disabled={props.disabled ? 'true' : undefined} onSubmit={(event: SubmitEvent) => { event.preventDefault(); void submit() }}>
		<div class="PromptComposer-status">
			<span class={['PromptComposer-activity', { busy: !!props.working && props.activity !== 'Idle', warning: props.activity === 'Reconnecting…' }]} aria-live="polite"><span aria-hidden="true">●</span> {props.activity}</span>
			<span class="PromptComposer-location">{props.location}</span>
			<Show when={props.context}><span class="PromptComposer-context">{props.context}</span></Show>
			<Show when={!draftDurable()}><span class="PromptComposer-draft-warning" role="status">Draft not saved — keep this page open</span></Show>
		</div>
		<div class="PromptComposer-input" ref={(element) => { inputShell = element }}>
			<textarea
				ref={(element) => { input = element }}
				rows={1}
				autocomplete="off"
				placeholder="Message"
				disabled={props.disabled}
				onInput={saveDraft}
				onFocus={autosize}
				onBlur={autosize}
				onKeyDown={onKeyDown}
				onPaste={onPaste}
			/>
		</div>
		<input ref={(element) => { fileInput = element }} type="file" accept="image/*" style="display: none" disabled={props.disabled} onChange={attachPickedFile} />
		<div class="PromptComposer-controls">
			<button type="button" class="PromptComposer-attach" disabled={attaching() || props.disabled} title="Attach image" onClick={() => fileInput?.click()}>📎</button>
			{/* Queue only exists while a turn runs: idle, sending already starts the
			    prompt immediately and a queue button would mean the same thing. */}
			<Show when={props.working}>
				<button type="button" disabled={attaching() || props.disabled} title="Run after the current turn" onClick={() => void submit(true)}>Queue</button>
			</Show>
			<button type="submit" disabled={attaching() || props.disabled}>{sendLabel(!!props.working)}</button>
		</div>
		<div class="PromptComposer-help"><b>enter</b> send <b>shift+enter</b> newline <Show when={props.working}><b>cmd+enter</b> queue</Show></div>
	</form>
}
