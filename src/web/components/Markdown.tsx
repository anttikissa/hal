/// <reference lib="dom" />
// Model text as elements (task fn), from the blocks of common/markdown.ts:
// runs are text nodes in styled spans and links only http(s) <a>s, so
// model text never reaches the page as HTML. Lists are non-keyed, so a
// streamed delta updates the blocks it touched in place.
// While `streaming`, the root keeps the tallest height it was drawn at
// as its min-height within one layout: streamed reparsing never
// shrinks it, but width/font reflow clears that obsolete height floor. On the root, not the card, so a folded thinking card still
// folds. `children` (Hal's cursor) follows the last line.

import { createEffect, createMemo, For, Match, onSettled, Show, Switch } from 'solid-js'
import type { JSX } from '@solidjs/web'
import { markdown, type Code, type Line, type Run, type Table } from '../../common/markdown.ts'

// Solid's string binding assigns Text.data, which resets native Range
// offsets even when text only grows. Edit only changed characters instead;
// never inspect or manipulate the browser's selection (task 1j).
function Text(props: { value: string }) {
	let node = document.createTextNode('')
	createEffect(() => props.value, (next) => {
		let old = node.data, start = 0, end = 0
		while (start < old.length && start < next.length && old[start] === next[start]) start++
		while (end < old.length - start && end < next.length - start && old[old.length - end - 1] === next[next.length - end - 1]) end++
		if (start + end !== old.length || start + end !== next.length)
			node.replaceData(start, old.length - start - end, next.slice(start, next.length - end))
	})
	return node
}

// A home-screen web app on iOS opens every link inside itself, even with
// target="_blank"; the x-safari- prefix hands web links to Safari.
export let external = (href: string) => ((navigator as { standalone?: boolean }).standalone && /^https?:/.test(href) ? `x-safari-${href}` : href)

function Runs(props: { runs: Run[] }) {
	let cls = (r: Run) => [r.bold && 'b', r.italic && 'i', r.code && 'code']
	return (
		<For each={props.runs} keyed={false}>
			{(r) => (
				<Switch>
					<Match when={!!r().href}><a class={cls(r())} href={external(r().href!)} target="_blank" rel="noopener noreferrer"><Text value={r().text} /></a></Match>
					<Match when={!r().href}><span class={cls(r())}><Text value={r().text} /></span></Match>
				</Switch>
			)}
		</For>
	)
}

export function Markdown(props: { text: string; streaming?: boolean; children?: JSX.Element }) {
	let blocks = createMemo(() => markdown.parse(props.text.trimEnd(), !!props.streaming))
	let root: HTMLDivElement | undefined
	let peak = 0
	onSettled(() => {
		let el = root!
		let layout = () => { let css = getComputedStyle(el); return `${el.clientWidth}:${css.fontSize}:${css.lineHeight}` }
		let previous = layout()
		let observer = new ResizeObserver(() => {
			let next = layout()
			if (next === previous) return
			previous = next; peak = 0; el.style.minHeight = ''
			if (props.streaming) { peak = el.getBoundingClientRect().height; el.style.minHeight = `${peak}px` }
		})
		observer.observe(el)
		return () => observer.disconnect()
	})
	createEffect(
		() => [blocks(), props.streaming] as const,
		([, streaming]) => {
			if (!streaming || !root) return
			peak = Math.max(peak, root.getBoundingClientRect().height)
			root.style.minHeight = `${peak}px`
		},
	)
	return (
		<div ref={(e) => (root = e)} class="Markdown">
			<For each={blocks()} keyed={false}>
				{(b) => {
					let l = () => b() as Line, c = () => b() as Code, t = () => b() as Table
					return <Switch>
						<Match when={b().type === 'line'}>
							<div class={['line', l().kind]}>
								<Show when={l().kind === 'li'}><span class="marker"><Text value={l().marker} /></span></Show>
								<span><Runs runs={l().runs} /></span>
							</div>
						</Match>
						<Match when={b().type === 'code'}>
							<pre data-lang={c().lang || undefined}><code><Text value={c().lines.join('\n')} /></code></pre>
						</Match>
						<Match when={b().type === 'table'}>
							<div class="table">
								<table>
									<thead>
										<tr>
											<For each={t().rows[0]} keyed={false}>{(c) => <th><Runs runs={c()} /></th>}</For>
										</tr>
									</thead>
									<tbody>
										<For each={t().rows.slice(1)} keyed={false}>
											{(row) => <tr><For each={row()} keyed={false}>{(c) => <td><Runs runs={c()} /></td>}</For></tr>}
										</For>
									</tbody>
								</table>
							</div>
						</Match>
					</Switch>
				}}
			</For>
			{props.children}
		</div>
	)
}
