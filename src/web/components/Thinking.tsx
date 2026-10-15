/// <reference lib="dom" />
// Content-first thinking with a measured short preview (task 6q1).
import { createEffect, createSignal, onSettled, Show } from 'solid-js'
import type { JSX } from '@solidjs/web'
import { settings } from '../../common/settings.ts'

export function Thinking(props: { text: string; open: boolean; time: string; metadata: JSX.Element; children: JSX.Element }) {
	let content: HTMLDivElement | undefined
	let preview: HTMLDivElement | undefined
	let [rows, setRows] = createSignal(settings.shortRows())
	let [hidden, setHidden] = createSignal(0)
	let measure = () => {
		if (!content) return
		let line = parseFloat(getComputedStyle(content).lineHeight)
		let total = Math.ceil(content.getBoundingClientRect().height / line)
		let visible = Math.min(total, settings.shortRows())
		setRows(Math.max(1, visible))
		setHidden(Math.max(0, total - visible))
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
	return <div class="Thinking" style={{ '--preview-rows': String(rows()) }}>
		<button type="button" class="stamp mark" aria-label={props.open ? 'Collapse reasoning' : 'Expand reasoning'} aria-expanded={props.open ? 'true' : 'false'}>{props.time}</button>
		<div class="preview" ref={(e) => { preview = e }}>
			<div class="thinking-content" ref={(e) => { content = e }}>{props.children}</div>
		</div>
		<span class="thinking-meta">{props.metadata}</span>
		<Show when={!props.open && hidden() > 0}><span class="more">… {hidden()} earlier lines</span></Show>
	</div>
}
