type PromptComposerProps = {
	onSubmit: (text: string) => Promise<boolean>
}

export function PromptComposer(props: PromptComposerProps) {
	let input: HTMLInputElement | undefined
	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault()
		const text = input?.value.trim() ?? ''
		if (!text || !input) return
		if (await props.onSubmit(text)) input.value = ''
	}
	return <form class="PromptComposer" onSubmit={submit}>
		<input ref={(element) => { input = element }} autocomplete="off" placeholder="Message" autofocus />
		<button>Send</button>
	</form>
}
