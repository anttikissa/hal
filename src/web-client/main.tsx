import { render } from '@solidjs/web'
import { startLegacyClient } from './legacy.js'

function App() {
	return <>
		<header id="tabs" />
		<main id="messages" />
		<form id="form">
			<input id="prompt" autocomplete="off" placeholder="Message" autofocus />
			<button>Send</button>
		</form>
	</>
}

const root = document.querySelector('#app')
if (!root) throw new Error('Missing app root')
render(() => <App />, root)
startLegacyClient()
