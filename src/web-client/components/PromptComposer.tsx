import { createSignal } from 'solid-js'

type PromptComposerProps = {
	onSubmit: (text: string) => Promise<boolean>
	onAttach: (file: File) => Promise<string>
}

// Append an attachment marker so it reads as part of the sentence: no double
// spaces before it, one trailing space so typing can continue right away.
function appendRef(value: string, path: string): string {
	const spacer = !value || /\s$/.test(value) ? '' : ' '
	return `${value}${spacer}[${path}] `
}

export function PromptComposer(props: PromptComposerProps) {
	let input: HTMLInputElement | undefined
	let fileInput: HTMLInputElement | undefined
	const [attaching, setAttaching] = createSignal(false)

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault()
		const text = input?.value.trim() ?? ''
		if (!text || !input) return
		if (await props.onSubmit(text)) input.value = ''
	}

	async function attach(): Promise<void> {
		const file = fileInput?.files?.[0]
		if (!file || !input) return
		if (!fileInput) return
		fileInput.value = '' // allow re-picking the same file
		setAttaching(true)
		try {
			const path = await props.onAttach(file)
			input.value = appendRef(input.value, path)
			input.focus()
		} catch (error) {
			alert(`Upload failed: ${error instanceof Error ? error.message : String(error)}`)
		} finally {
			setAttaching(false)
		}
	}

	return <form class="PromptComposer" onSubmit={submit}>
		<input ref={(element) => { input = element }} autocomplete="off" placeholder="Message" autofocus />
		<input ref={(element) => { fileInput = element }} type="file" accept="image/*" style="display: none" onChange={attach} />
		<button type="button" disabled={attaching()} title="Attach image" onClick={() => fileInput?.click()}>📎</button>
		<button disabled={attaching()}>Send</button>
	</form>
}
