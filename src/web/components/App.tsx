/// <reference lib="dom" />
// The page: straight to the conversation if the cookie is good, else
// the one-time code gate first.

import { createSignal, Match, onSettled, Switch } from 'solid-js'
import { app } from '../app.ts'
import { Chat } from './Chat.tsx'
import { Login } from './Login.tsx'

export function App() {
	let [phase, setPhase] = createSignal<'checking' | 'login' | 'chat'>('checking')
	onSettled(() => {
		void app.authorized().then((ok) => setPhase(ok ? 'chat' : 'login'))
	})
	return (
		<div class="App">
			<Switch>
				<Match when={phase() === 'login'}>
					<Login onDone={() => setPhase('chat')} />
				</Match>
				<Match when={phase() === 'chat'}>
					<Chat />
				</Match>
			</Switch>
		</div>
	)
}
