/// <reference lib="dom" />
// Content-first thinking with a measured short preview (task 6q1).
import { createEffect, createSignal, onSettled, Show } from 'solid-js'
import type { JSX } from '@solidjs/web'
import { settings } from '../../common/settings.ts'

export function Thinking(props: { text: string; open: boolean; time: string; metadata: JSX.Element; children: JSX.Element }) {
	let content: HTMLDivElement | undefined
	let [rows, setRows] = createSignal(settings.shortRows())
	let [hidden, setHidden] = createSignal(0)
	let measure = () => {
		if (!content) return
		let line = parseFloat(getComputedStyle(content).lineHeight)
		let total = Math.ceil(content.getBoundingClientRect().height / line)
		let visible = Math.min(total, settings.shortRows())
		let top = content.getBoundingClientRect().top
		let blanks = 0
		for (let node of content.querySelector<HTMLElement>('.Markdown')?.children ?? []) {
			let rect = node.getBoundingClientRect()
			if (rect.top - top >= visible * line - 0.1) break
			blanks = node.textContent?.trim() ? 0 : blanks + 1
		}
		visible -= blanks
		setRows(Math.max(1, visible))
		setHidden(Math.max(0, total - visible))
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
		<div class="preview">
			<div class="thinking-content" ref={(e) => { content = e }}>
				<span class="thinking-meta">{props.metadata}</span>
				<button type="button" class="stamp mark" aria-label={props.open ? 'Collapse reasoning' : 'Expand reasoning'} aria-expanded={props.open ? 'true' : 'false'}>{props.time}</button>
				{props.children}
			</div>
		</div>
		<Show when={!props.open && hidden() > 0}><span class="more">… {hidden()} more lines</span></Show>
	</div>
}
