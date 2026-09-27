/// <reference lib="dom" />
// The browser client's entry point: host/web.ts bundles this file (and
// what it imports) into index.html. Runs in the browser only;
// importing it elsewhere does nothing.

import { render } from '@solidjs/web'
import { settings } from '../common/settings.ts'
import { App } from './components/App.tsx'

// The host's settings (config.ason) are read before the first render.
if (typeof document !== 'undefined') {
	settings.load(document.getElementById('settings')?.textContent)
	render(() => <App />, document.body)
}
