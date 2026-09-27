/// <reference lib="dom" />
// The page: straight to the conversation if the cookie is good, else
// the one-time code gate first.

import { createSignal, Match, onSettled, Switch } from 'solid-js'
import { app } from '../app.ts'
import { router } from '../router.ts'
import { Chat } from './Chat.tsx'
import { Login } from './Login.tsx'

export function App() {
	let [phase, setPhase] = createSignal<'checking' | 'login' | 'chat'>('checking')
	// The gate at a file's address (/image/<name>) goes back to the file.
	let loggedIn = () => (router.isApp(router.href()) ? setPhase('chat') : location.reload())
	onSettled(() => {
		void app.authorized().then((ok) => (ok ? loggedIn() : setPhase('login')))
	})
	return (
		<div class="App">
			<Switch>
				<Match when={phase() === 'login'}>
					<Login onDone={loggedIn} />
				</Match>
				<Match when={phase() === 'chat'}>
					<Chat />
				</Match>
			</Switch>
		</div>
	)
}
