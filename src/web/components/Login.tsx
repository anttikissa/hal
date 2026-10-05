/// <reference lib="dom" />
// The gate: a one-time code (from /auth or hal auth) sets the cookie
// and calls onDone.

import { createSignal, onSettled } from 'solid-js'
import { app } from '../app.ts'

export function Login(props: { onDone: () => void }) {
	let [notice, setNotice] = createSignal('')
	let input!: HTMLInputElement
	onSettled(() => input.focus())
	let submit = async (e: SubmitEvent) => {
		e.preventDefault()
		let failed = await app.login(input.value)
		if (failed === undefined) return props.onDone()
		setNotice(failed)
		input.select()
	}
	return (
		<form class="Login" onSubmit={submit}>
			<label for="code">Enter a one-time code: type /auth in Hal, or hal auth in a shell.</label>
			<input ref={(e) => (input = e)} id="code" name="code" autocomplete="one-time-code" autocapitalize="none" spellcheck={false} />
			<button>Log in</button>
			<div id="notice" class="log">
				{notice()}
			</div>
		</form>
	)
}
