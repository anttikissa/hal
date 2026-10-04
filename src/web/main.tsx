/// <reference lib="dom" />
// The browser client's entry point: host/web.ts bundles this file (and
// what it imports) into index.html. Runs in the browser only;
// importing it elsewhere does nothing.

import { render } from '@solidjs/web'
import { settings } from '../common/settings.ts'
import { connection } from '../common/connection.ts'
import { app } from './app.ts'
import { diagnostics } from './diagnostics.ts'
import { App } from './components/App.tsx'

// The host's settings (config.ason) are read before the first render.
if (typeof document !== 'undefined') {
	diagnostics.init(() => {
		let st = app.state, t = st.view.transcript, vv = visualViewport
		return { tab: Math.max(0, st.tabs.findIndex((t) => t.id === st.shown) + 1), renderedTab: Number(document.querySelector('.Tabs .strip [aria-current] .n')?.textContent) || 0, tabs: st.tabs.length, cached: st.cached.size,
			items: t?.items.length ?? 0, live: !!t?.live, modal: !!st.view.modal, form: !!st.view.form,
			connected: connection.connected(), visible: document.visibilityState === 'visible', focused: document.hasFocus(),
			standalone: matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone,
			width: innerWidth, height: innerHeight, viewportHeight: vv?.height ?? innerHeight, viewportTop: Math.max(0, vv?.offsetTop ?? 0),
			scrollTop: Math.max(0, document.querySelector('.Transcript')?.scrollTop ?? 0),
			appHeight: parseFloat(document.documentElement.style.getPropertyValue('--app-height')) || innerHeight, composerFocused: !!document.activeElement?.closest('.Composer') }
	})
	settings.load(document.getElementById('settings')?.textContent)
	render(() => <App />, document.body)
}
