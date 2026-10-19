/// <reference lib="dom" />
// A live card's ticker in its header (Card.tsx, task hyt): the time since
// `since`, against the tool's time limit, and a spinner that turns while
// `live`.

import { createEffect, createSignal, Show } from 'solid-js'
import { bashResult } from '../../common/bash-result.ts'

export function CardActivity(props: { live: boolean; since?: string; spins: boolean; limit?: string }) {
	let [now, setNow] = createSignal(Date.now())
	createEffect(
		() => props.live,
		(on) => {
			if (!on) return
			setNow(Date.now())
			let t = setInterval(() => setNow(Date.now()), 1000)
			return () => clearInterval(t)
		},
	)
	let elapsed = () => {
		let ts = Date.parse(props.since ?? '')
		return props.live && Number.isFinite(ts) ? bashResult.duration(now() - ts, true) : undefined
	}
	return (
		<Show when={props.spins}>
			<span class="ticker">
				<Show when={elapsed()}>
					{(e) => (
						<span class="elapsed">
							({e()}
							{props.limit ? ` / ${props.limit}` : ''})
						</span>
					)}
				</Show>
				<span class={['spinner', props.live ? 'on' : '']} aria-hidden="true" />
			</span>
		</Show>
	)
}
