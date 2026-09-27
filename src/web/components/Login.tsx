/// <reference lib="dom" />
// The password form; a good password sets the cookie and calls onDone.

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
			<input ref={(e) => (input = e)} type="password" name="password" placeholder="Password" aria-label="Password" />
			<button>Log in</button>
			<div id="notice" class="log">
				{notice()}
			</div>
		</form>
	)
}
