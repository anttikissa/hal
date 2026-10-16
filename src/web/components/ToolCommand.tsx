/// <reference lib="dom" />
import { createEffect, createSignal, flush, onSettled, Show, untrack } from 'solid-js'
import { scroll } from '../scroll.ts'

export function ToolCommand(props: { lines: string[]; compact: boolean }) {
	let line: HTMLDivElement | undefined
	let [expanded, setExpanded] = createSignal(false)
	let [overflow, setOverflow] = createSignal(false)
	let clipped = () => props.lines.length > 1 || overflow()
	let whole = () => !props.compact || expanded()
	let measure = () => untrack(() => { if (line && !whole()) setOverflow(line.scrollWidth > line.clientWidth) })
	onSettled(() => {
		let observer = new ResizeObserver(measure)
		observer.observe(line!)
		measure()
		return () => observer.disconnect()
	})
	createEffect(() => [props.lines, whole()] as const, () => measure())
	let toggle = () => scroll.follow(() => { setExpanded(!expanded()); flush() })
	return (
		<div class="ToolCommand">
			<div ref={(el) => (line = el)} class={whole() ? 'command' : 'command clipped'}>{whole() ? props.lines.join('\n') : (props.lines[0] ?? '') + (props.lines.length > 1 ? '…' : '')}</div>
			<Show when={props.compact && clipped()}><button type="button" class="command-toggle" aria-expanded={expanded() ? 'true' : 'false'} onClick={toggle}><span class="label">{expanded() ? 'Hide command' : 'Show command'}</span></button></Show>
		</div>
	)
}
