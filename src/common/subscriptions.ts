// One client-wide account store; plans only identify an account (task w0d).
// The browser installs a Solid 2 store; terminal clients use plain data.
import type { Plan } from './protocol.ts'

export type SubscriptionWindows = Record<string, { used: number; resets?: string; observed?: string }>
export type SubscriptionData = Record<string, SubscriptionWindows>

function key(provider: string, account: string): string {
	return JSON.stringify([provider, account])
}

function apply(accounts: SubscriptionData, replace = false): void {
	subscriptions.write((draft) => {
		if (replace) for (let name of Object.keys(draft)) if (!(name in accounts)) delete draft[name]
		for (let [name, windows] of Object.entries(accounts)) {
			let current = draft[name] ??= {}
			for (let span of Object.keys(current)) if (!(span in windows)) delete current[span]
			for (let [span, window] of Object.entries(windows)) {
				let value = current[span] ??= { used: 0 }
				value.used = window.used
				if (window.resets === undefined) delete value.resets
				else value.resets = window.resets
				if (window.observed === undefined) delete value.observed
				else value.observed = window.observed
			}
		}
	})
}

function install(data: SubscriptionData, write: (update: (draft: SubscriptionData) => void) => void): void {
	subscriptions.state = data
	subscriptions.write = write
}

function plan(plan: Plan): { windows: Record<string, number>; resets: Record<string, string> } {
	let windows: Record<string, number> = {}, resets: Record<string, string> = {}
	for (let [name, w] of Object.entries(subscriptions.state[plan.key] ?? {})) {
		if (/^\d+[a-z]+[-_]/.test(name)) continue
		windows[name] = Math.round(w.used)
		if (w.resets) resets[name] = w.resets
	}
	return { windows, resets }
}

export const subscriptions = {
	state: {} as SubscriptionData,
	write: (update: (draft: SubscriptionData) => void): void => update(subscriptions.state),
	install, key, apply, plan,
}
