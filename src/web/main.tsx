/// <reference lib="dom" />
// The browser client's entry point: host/web.ts bundles this file (and
// what it imports) into index.html. Runs in the browser only;
// importing it elsewhere does nothing.

import { render } from '@solidjs/web'
import { settings } from '../common/settings.ts'
import { sendKeys } from '../common/send-keys.ts'
import { connection } from '../common/connection.ts'
import { createStore, reconcile } from 'solid-js'
import { subscriptions, type SubscriptionData } from '../common/subscriptions.ts'
import { app } from './app.ts'
import { diagnostics } from './diagnostics.ts'
import { drift } from './drift.ts'
import { App } from './components/App.tsx'

// The host's settings (config.ason) are read before the first render.
if (typeof document !== 'undefined') {
	let [usage, setUsage] = createStore<SubscriptionData>({})
	subscriptions.install(usage, (accounts, replace) => setUsage((draft) => {
		if (replace) reconcile(accounts)(draft)
		else for (let [key, windows] of Object.entries(accounts)) {
			if (draft[key]) reconcile(windows)(draft[key])
			else draft[key] = windows
		}
	}))
	settings.load(document.getElementById('settings')?.textContent)
	sendKeys.load(document.getElementById('send-keys')?.textContent)
	// Off unless config.ason opts in (webDiagnostics).
	if (settings.webDiagnostics()) diagnostics.init(() => {
		let st = app.state, t = st.view.transcript, vv = visualViewport
		return { tab: Math.max(0, st.tabs.findIndex((t) => t.id === st.shown) + 1), renderedTab: Number(document.querySelector('.Tabs .strip [aria-current] .n')?.textContent) || 0, tabs: st.tabs.length, cached: st.cached.size,
			items: t?.items.length ?? 0, live: !!t?.live, modal: !!st.view.modal, form: !!st.view.form,
			connected: connection.connected(), visible: document.visibilityState === 'visible', focused: document.hasFocus(),
			standalone: matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone,
			width: innerWidth, height: innerHeight, viewportHeight: vv?.height ?? innerHeight, viewportTop: Math.max(0, vv?.offsetTop ?? 0),
			scrollTop: Math.max(0, document.querySelector('.Transcript')?.scrollTop ?? 0),
			appHeight: parseFloat(document.documentElement.style.getPropertyValue('--app-height')) || innerHeight, composerFocused: !!document.activeElement?.closest('.Composer') }
	})
	if (settings.webDiagnostics()) drift.init()
	render(() => <App />, document.body)
}
