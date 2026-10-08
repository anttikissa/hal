// One client-wide account store; plans only identify an account (task w0d).
// The browser installs a Solid 2 store; terminal clients use plain data.
import type { Plan } from './protocol.ts'

export type SubscriptionWindows = Record<string, { used: number; resets?: string; observed?: string }>
export type SubscriptionData = Record<string, SubscriptionWindows>

function key(provider: string, account: string): string {
	return JSON.stringify([provider, account])
}

function install(data: SubscriptionData, update: (accounts: SubscriptionData, replace?: boolean) => void): void {
	subscriptions.state = data
	subscriptions.update = update
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
	apply: (accounts: SubscriptionData, replace = false): void => subscriptions.update(accounts, replace),
	update: (accounts: SubscriptionData, replace = false): void => {
		subscriptions.state = replace ? accounts : { ...subscriptions.state, ...accounts }
	},
	install, key, plan,
}
