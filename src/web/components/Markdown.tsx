/// <reference lib="dom" />
// Model text as elements (task fn), from the blocks of common/markdown.ts:
// runs are text nodes in styled spans and links only http(s) <a>s, so
// model text never reaches the page as HTML. Lists are non-keyed, so a
// streamed delta updates the blocks it touched in place.
// While `streaming`, the root keeps the tallest height it was drawn at
// as its min-height, until the page reloads: a streaming block never
// shrinks. On the root, not the card, so a folded thinking card still
// folds. `children` (Hal's cursor) follows the last line.

import { createEffect, createMemo, For, Match, Show, Switch } from 'solid-js'
import type { JSX } from '@solidjs/web'
import { markdown, type Code, type Line, type Run, type Table } from '../../common/markdown.ts'

function Runs(props: { runs: Run[] }) {
	let cls = (r: Run) => [r.bold && 'b', r.italic && 'i', r.code && 'code']
	return (
		<For each={props.runs} keyed={false}>
			{(r) => (
				<Show when={r().href} fallback={<span class={cls(r())}>{r().text}</span>}>
					{(href) => <a class={cls(r())} href={href()} target="_blank" rel="noopener noreferrer">{r().text}</a>}
				</Show>
			)}
		</For>
	)
}

export function Markdown(props: { text: string; streaming?: boolean; children?: JSX.Element }) {
	let blocks = createMemo(() => markdown.parse(props.text.trimEnd(), !!props.streaming))
	let root: HTMLDivElement | undefined
	let peak = 0
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
				{(b) => (
					<Switch>
						<Match when={b().type === 'line' && (b() as Line)}>
							{(l) => (
								<div class={['line', l().kind]}>
									<Show when={l().kind === 'li'}><span class="marker">{l().marker}</span></Show>
									<span><Runs runs={l().runs} /></span>
								</div>
							)}
						</Match>
						<Match when={b().type === 'code' && (b() as Code)}>
							{(c) => <pre data-lang={c().lang || undefined}><code>{c().lines.join('\n')}</code></pre>}
						</Match>
						<Match when={b().type === 'table' && (b() as Table)}>
							{(t) => (
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
							)}
						</Match>
					</Switch>
				)}
			</For>
			{props.children}
		</div>
	)
}
