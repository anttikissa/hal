/// <reference lib="dom" />
// Content-first thinking with a measured short preview (task 6q1).
import { createEffect, createSignal, onSettled, Show } from 'solid-js'
import type { JSX } from '@solidjs/web'

export function Thinking(props: { text: string; open: boolean; children: JSX.Element }) {
	let content: HTMLDivElement | undefined
	let preview: HTMLDivElement | undefined
	let [hidden, setHidden] = createSignal(0)
	let measure = () => {
		if (!content) return
		let line = parseFloat(getComputedStyle(content).lineHeight)
		let box = content.getBoundingClientRect()
		let total = Math.ceil(box.height / line)
		setHidden(Math.max(0, total - 1))
		onSettled(() => { if (preview) preview.scrollTop = props.open ? 0 : preview.scrollHeight })
	}
	onSettled(measure)
	createEffect(() => [props.text, props.open], () => onSettled(measure))
	onSettled(() => {
		if (!content) return
		let observer = new ResizeObserver(measure)
		observer.observe(content)
		return () => observer.disconnect()
	})
	return <div class="Thinking">
		<div class="preview" ref={(e) => { preview = e }}>
			<div class="thinking-content" ref={(e) => { content = e }}>{props.children}</div>
		</div>
		<Show when={!props.open && hidden() > 0}><span class="more">… {hidden()} earlier lines</span></Show>
	</div>
}
