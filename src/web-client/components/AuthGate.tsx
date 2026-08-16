type AuthGateProps = {
	onConnect: (token: string) => void
}

export function AuthGate(props: AuthGateProps) {
	let input: HTMLInputElement | undefined
	function connect(event: SubmitEvent): void {
		event.preventDefault()
		const token = input?.value.trim() ?? ''
		if (token) props.onConnect(token)
	}
	return <main class="AuthGate">
		<h1>Hal web interface</h1>
		<p>This interface needs an access token.</p>
		<p>In a Hal terminal, run <code>/web</code> to show an access URL, or <code>/web auth</code> to create one.</p>
		<form onSubmit={connect}>
			<input ref={(element) => { input = element }} autocomplete="off" placeholder="Paste access token" />
			<button>Connect</button>
		</form>
	</main>
}
