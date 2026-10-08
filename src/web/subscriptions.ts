// Solid 2 owns the browser's single quota store (task w0d).
import { createStore } from 'solid-js'
import { subscriptions, type SubscriptionData } from '../common/subscriptions.ts'

function init(): void {
	let [data, setData] = createStore<SubscriptionData>({})
	subscriptions.install(data, (update) => { setData(update) })
}

export const subscriptionStore = { init }
