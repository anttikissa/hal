/// <reference lib="dom" />
// Find's web look: rows grouped by kind under section rules, each row,
// filter and preview card wearing its kind's theme colors (user, Hal,
// tools...) as the transcript's cards do, and key caps in the footer.
import { createEffect, createMemo, For, onCleanup, Show } from 'solid-js'
import type { FindFilter, FindKind, FindPreview, FindResult } from '../../common/find.ts'
import { findDialog } from '../../common/find-dialog.ts'
import { transcript } from '../../common/transcript.ts'
import { app } from '../app.ts'
import { transcriptRows } from '../transcript-rows.ts'
import { Card } from './Card.tsx'
import { marked } from './Picker.tsx'

const sections: Record<FindKind, string> = {
	metadata: 'tabs',
	user: 'messages',
	assistant: 'messages',
	thinking: 'reasoning',
	'tool-call': 'tools',
	'tool-output': 'tools',
	commit: 'commits',
	other: 'other',
}
const names: Record<FindKind, string> = {
	metadata: 'title',
	user: 'user',
	assistant: 'Hal',
	thinking: 'reasoning',
	'tool-call': 'tool',
	'tool-output': 'output',
	commit: 'commit',
	other: 'other',
}
// Theme style classes (host/web-page.ts) per kind.
const styles: Record<FindKind, string> = {
	metadata: 'find-tab',
	user: 'user',
	assistant: 'assistant',
	thinking: 'thinking',
	'tool-call': 'tool',
	'tool-output': 'tool',
	commit: 'commit-card',
	other: 'plain',
}
const filterStyles: Record<FindFilter, string> = {
	user: 'user',
	hal: 'assistant',
	reasoning: 'thinking',
	tools: 'tool-read',
	commits: 'commit-card',
	other: 'plain',
}

// Tool-call rows and cards are labeled by their command verb, such as READ.
function toolStyle(name = 'tool'): string {
	return name === 'tool' ? 'tool' : `tool tool-${name.toLowerCase().replace(/_/g, '-')}`
}
function section(r: FindResult): string {
	return r.count ? 'tabs' : sections[r.kind]
}
function rowStyle(r: FindResult): string {
	return r.count ? 'find-tab' : r.kind === 'tool-call' ? toolStyle(r.why) : styles[r.kind]
}
function who(r: FindResult): string {
	if (r.count) return ''
	if (r.kind === 'tool-call') return r.why
	return r.kind === 'metadata' ? r.why : names[r.kind]
}
function tabNumber(r: FindResult, tabs: string[]): string {
	let n = tabs.indexOf(r.sessionId)
	return n < 0 ? '' : String(n + 1)
}
// An open tab's marker in its project color, as in the tab bar.
function tabColor(r: FindResult) {
	let color = app.state.tabs.find((t) => t.id === r.sessionId)?.color
	return color === undefined ? undefined : { background: `var(--p${color})` }
}

// The section heading above each row that starts a run of one kind.
function headings(results: FindResult[]): ({ name: string; count: number } | undefined)[] {
	let out: ({ name: string; count: number } | undefined)[] = []
	let start = 0
	results.forEach((r, i) => {
		if (i && section(results[i - 1]!) === section(r)) out.push(undefined)
		else {
			start = i
			out.push({ name: section(r), count: 0 })
		}
		out[start]!.count++
	})
	return out
}

function Heading(props: { name: string; count: number }) {
	return (
		<div class="heading" aria-hidden="true">
			<span>{props.name}</span>
			<span class="rule" />
			<span>{props.count}</span>
		</div>
	)
}

function Row(props: { r: FindResult; tabs: string[]; query: string; onOpen: (e: MouseEvent) => void }) {
	let r = () => props.r
	let id = () => (r().card && !r().count ? `${r().sessionId}/${r().card}` : r().sessionId)
	let text = () => (r().count && r().why === 'title' ? r().cwd : findDialog.snippet(r(), props.query, 6))
	return (
		<a class={`find-row ${rowStyle(r())}`} href={r().href} tabindex={-1} onClick={props.onOpen}>
			<span class="tab">{tabNumber(r(), props.tabs)}</span>
			<span class="id">{id()}</span>
			<span class="who">{who(r())}</span>
			<span class="name">{marked(r().name, props.query, true)}</span>
			<span class="text">{marked(text(), props.query, true)}</span>
			<span class="age">
				<Show when={r().count ? tabColor(r()) : undefined}>{(s) => <span class="mark" style={s()} />}</Show>
				{findDialog.age(r().age)}
			</span>
		</a>
	)
}

function FilterBox(props: { filter: FindFilter; label: string }) {
	return (
		<>
			<span class={`box ${filterStyles[props.filter]}`} aria-hidden="true" />
			<span class="label">{props.label}</span>
		</>
	)
}

// The hit and its neighbors as the transcript's own cards, the query's
// matches lit by a CSS highlight over their text.
function Preview(props: {
	preview: FindPreview
	result?: FindResult
	tabs: string[]
	query: string
	ref: (e: HTMLDivElement) => void
}) {
	let pane: HTMLDivElement | undefined
	let rows = createMemo(() =>
		transcriptRows.rows(props.preview.records.flatMap((r, i) => transcript.recordItems(r, i))),
	)
	createEffect(
		() => [rows(), props.query] as const,
		([, query]) => {
			let ranges: Range[] = []
			let walk = document.createTreeWalker(pane!, NodeFilter.SHOW_TEXT)
			for (let n = walk.nextNode(); n; n = walk.nextNode())
				for (let [a, b] of findDialog.marks(n.textContent ?? '', findDialog.words(query))) {
					let r = new Range()
					r.setStart(n, a)
					r.setEnd(n, b)
					ranges.push(r)
				}
			CSS.highlights.set('find', new Highlight(...ranges))
		},
	)
	onCleanup(() => CSS.highlights.delete('find'))
	return (
		<div
			class="preview"
			ref={(e) => {
				pane = e
				props.ref(e)
			}}
			aria-label="Preview"
		>
			<Show when={props.result}>
				{(r) => (
					<div class="head">
						{r().sessionId}
						<Show when={tabNumber(r(), props.tabs)}>{(n) => <span>tab {n()}</span>}</Show>
						<span>{findDialog.age(r().age)}</span>
					</div>
				)}
			</Show>
			<Show when={props.preview.error}>{(e) => <div class="refused">{e()}</div>}</Show>
			<For each={rows()}>
				{(row) => <Card row={row} session={props.preview.sessionId} target={row.key === props.preview.blockId} />}
			</For>
		</div>
	)
}

// "↑↓: move · enter: open" as key caps and words.
function Keys(props: { hint: string }) {
	return (
		<For each={props.hint.split(' · ')}>
			{(part) => {
				let at = part.indexOf(': ')
				return (
					<span class="key">
						<kbd>{part.slice(0, at)}</kbd> {part.slice(at + 2)}
					</span>
				)
			}}
		</For>
	)
}

export const findView = { headings, Heading, Row, FilterBox, Preview, Keys }
