/// <reference lib="dom" />
// One transcript row as a card in its theme colors (view.show). A
// thinking or tool card (the call with its result) folds, closed at
// first: its header is a button naming what is inside, and a click
// anywhere on the card toggles it, except on a link or a click that
// ends a text selection. Hidden contents are inert. The height
// animates in CSS; scroll.ts tracks the bottom meanwhile. `cursor`:
// the card streams, so Hal's cursor follows its last character (in the
// header while a folding card is closed). Whether a card is open is
// kept by its session and row key (task w5), not by its DOM, so no other
// item's card ever shows open in its place.
// Every card links to itself (target.ts, task 0z); `target`: the
// address links here, so the card is marked and opens, a tool card
// with its whole output. An open tool card shows a glimpse of its
// result and can show all of it; the transcript holds all of it
// (host tools cap what they keep), so nothing is fetched.

import { createEffect, createMemo, createSignal, flush, For, onSettled, Show, untrack } from 'solid-js'
import { bashResult } from '../../common/bash-result.ts'
import { markdown as parser } from '../../common/markdown.ts'
import { titles } from '../../common/titles.ts'
import { toolDetails } from '../../common/tool-details.ts'
import { transcript } from '../../common/transcript.ts'
import { external, Markdown } from './Markdown.tsx'
import { CardHeader } from './CardHeader.tsx'
import { Icon } from './Icon.tsx'
import type { IconName } from '../icons.ts'
import { promptChanges } from '../../common/prompt-changes.ts'
import { app } from '../app.ts'
import { editPrompt } from '../edit-prompt.ts'
import { scroll } from '../scroll.ts'
import { target } from '../target.ts'
import { view, type Row } from '../view.ts'
import { hrefs } from '../hrefs.ts'
import { folds } from '../folds.ts'

const { opened, toggled } = folds
// Tool cards showing their whole result, by the same key.
const [whole, setWhole] = createSignal<ReadonlySet<string>>(new Set())

// A new card fades in (--fade-ms, --ease-out from the page's CSS). A
// script animation, not a CSS one: moving the card in the list, as when
// a pending command lands where it ran (task rk), would restart a CSS
// animation, which reads as the card appearing again. Started once the
// card is in the page: a node cloned from a template belongs to an inert
// document, whose animations never run.
let fade: KeyframeAnimationOptions | undefined
function enter(el: HTMLElement): void {
	if (scroll.state.quiet) return
	if (!fade) {
		let css = getComputedStyle(document.documentElement)
		fade = { duration: parseFloat(css.getPropertyValue('--fade-ms')) || 0, easing: css.getPropertyValue('--ease-out').trim() || 'ease-out' }
	}
	el.animate({ opacity: [0, 1] }, fade)
}

// An image row shows the image itself, from the session's blob.
// `job`: the background job this Bash call started still runs; a Kill
// button in the header sends /kill #<job>.
// `edit`: a prompt the user may edit and resend; its header offers Edit
// (task 26q, edit-prompt.ts), which loads it into the box.
// A bash command that starts Python in command position (line start or
// after ; & | ( $( ), optionally behind env assignments or a wrapper.
const runsPython = /(?:^|[;&|(]|\$\()\s*(?:\w+=\S*\s+|(?:env|exec|time|nice|uv run|timeout \S+)\s+)*(?:\S*\/)?python(?:3(?:\.\d+)?)?(?=[\s;&|)]|$)/m
// Tool cards' header icons, by tool name.
const toolIcons: Record<string, IconName> = { bash: 'bash', read: 'read', read_url: 'web', google: 'google', send: 'message', spawn: 'spawn', wait: 'wait', command: 'command', inspect: 'inspect', notify: 'notify', ask: 'ask', read_blob: 'blob' }

export function Card(props: { row: Row; session: string; cursor?: boolean; target?: boolean; job?: string; edit?: boolean; discard?: boolean }) {
	let id = () => `${props.session}#${props.row.key}`
	let root: HTMLElement | undefined
	onSettled(() => root && enter(root))
	let open = () => opened().has(id())
	// The setters may run in an effect: they read the state as of the call.
	let setOpen = (on: boolean) => untrack(() => folds.set(id(), props.row.item, on, [props.row.key, ...(props.row.result ? [props.row.result.key] : [])], closable()))
	// Assistant text and the user's prompts start open; /toggle closes
	// them (task r4d), and a closed one folds like thinking.
	let closable = () => props.row.note === undefined && folds.closable(props.row.item)
	let shut = () => closable() && folds.closed().has(id())
	let expanded = () => (closable() ? !shut() : open())
	// A tool still streaming after a second opens and stays open (task
	// a5): opening at once and closing on the result made quick calls
	// flash and jolted the scroll.
	let running = () => props.row.item.type === 'tool' && !!props.row.item.partial && !props.row.result
	createEffect(running, (on) => {
		if (!on) return
		let t = setTimeout(() => running() && setOpen(true), 1000)
		return () => clearTimeout(t)
	})
	let full = () => whole().has(id())
	let setFull = (on: boolean) => untrack(() => setWhole(toggled(whole(), id(), on)))
	createEffect(
		() => props.target,
		(on) => {
			if (!on) return
			setOpen(true)
			setFull(true)
		},
	)
	let shown = () => view.show(props.row.item)
	let result = () => props.row.result && view.show(props.row.result, full())
	// Whether the result is longer than its glimpse.
	let long = () => (props.row.result ? props.row.result.output.replace(/\n$/, '').split('\n').length : 0) > view.resultRows
	// The link shows the block's id, #t35, as the terminal does. Its
	// text is drawn by CSS from data-ref, so copying the card's text
	// leaves it out.
	let blockId = () => titles.blockId(props.row.item)
	let href = () => (props.row.pending || (props.row.waiting && props.row.note === undefined) ? undefined : target.href(props.session, blockId()))
	let link = () => (
		<Show when={href()}>
			{(h) => (
				<a class="link" href={h()} data-ref={`#${blockId()}`} title="Link to this block" aria-label={`Link to block ${blockId()}`} />
			)}
		</Show>
	)
	// Another session's message with a summary folds under it.
	// Prompt-file changes fold under their summary (task ar).
	let folding = () => shut() || props.row.item.type === 'thinking' || props.row.item.type === 'tool' || (props.row.item.type === 'prompt' && !!props.row.item.summary) || (props.row.item.type === 'output' && !!props.row.item.change)
	// A tool's first line (its description or call) heads the card;
	// thinking is headed by the terminal's header words and its first
	// line. Prompts and model text show those words above their text
	// (task hp).
	let title = () => titles.title(props.row.item)
	let source = () => props.row.item.type === 'prompt' && props.row.item.label?.match(/^bash #(t?\d+)$/)?.[1]
	let who = () => {
		let item = props.row.item
		// A question is headed by its text, its addresses links.
		if (item.type === 'question') return <For each={hrefs.urlParts(item.form.text)}>{(part) => typeof part === 'string' ? part : <a href={external(part.href)} target="_blank" rel="noopener noreferrer">{part.text}</a>}</For>
		let ref = source(), t = titles.who(item)
		return ref && t?.endsWith(`#${ref}`) ? <>{t.slice(0, -ref.length - 1)}<a class="call" href={transcript.href(props.session, ref)} title="Go to Bash call">#{ref}</a></> : t
	}
	let marked = (s: string) => {
		let match = /\[exit [1-9]\d*\]/.exec(s)
		return match ? <>{s.slice(0, match.index)}<span class="exit">{match[0]}</span>{s.slice(match.index + match[0].length)}</> : s
	}
	let lines = () => (shown()?.text ?? '').replace(/^▸ /, '').split('\n')
	let head = () => {
		let item = props.row.item
		// Closed thinking spends its width on the preview, not a label.
		// Open cards keep the effort header; controls retain a named kind.
		if (item.type === 'thinking') {
			let first = expanded() ? '' : parser.inline(lines()[0] ?? '').map((r) => r.text).join('').trim()
			return first ? `${first}${item.originSession ? ` (in ${item.originSession})` : ''}` : titles.who(item)
		}
		if (item.type === 'prompt' && item.summary) return titles.messageHead(item)
		if (item.type === 'output' && item.change) return item.text.split('\n')[0]
		return item.type === 'tool' ? toolDetails.headline(item.name, item.input, props.row.result?.output).text : lines()[0]
	}
	// Folded cards name their kind with an icon: thinking, another
	// session's message or command (the send tool's bubble, which
	// unfolded ones show too), or the tool.
	let kindIcon = (): IconName | undefined => {
		let item = props.row.item
		if (item.type === 'thinking') return 'thinking'
		if (titles.letter(item) === 'm') return 'message'
		if (item.type !== 'tool') return undefined
		if (item.name === 'bash' && typeof item.input.command === 'string' && runsPython.test(item.input.command)) return 'python'
		return toolIcons[item.name]
	}
	let headerParts = createMemo(() => hrefs.urlParts(head() ?? ''))
	let body = () => {
		let item = props.row.item
		if (item.type !== 'tool') return lines().join('\n')
		// The call once (task 8t), then its output: the result, or what
		// has streamed so far.
		let call = toolDetails.lines(item.name, item.input)
		let out = result()?.text ?? item.partial?.replace(/\n$/, '')
		let mark = item.name === 'bash' ? marked : (s: string) => s
		return <>{[...call, ...(out && call.length ? [''] : [])].map((l) => l + '\n').join('')}{out ? <span class={failed() ? 'result-text error' : 'result-text'}>{mark(out)}</span> : ''}</>
	}
	let failed = () => !!props.row.result?.isError
	let toggle = (e: MouseEvent) => {
		if ((!folding() && props.row.note === undefined) || (e.target as Element).closest('a, .more, .kill, .edit, .discard') || !getSelection()?.isCollapsed) return
		scroll.follow(() => {
			setOpen(!expanded())
			flush()
		}, 'track')
	}
	// Show all of a tool's result, or its glimpse again, keeping the
	// button (the card's end) in view as the card shrinks.
	let more = (e: MouseEvent) => {
		let button = e.currentTarget as HTMLElement
		scroll.follow(() => {
			setFull(!full())
			flush()
		}, 'track')
		if (!full()) button.scrollIntoView({ block: 'nearest' })
	}
	let cursor = () => <span class="cursor" aria-hidden="true" />
	// Model text and inter-tab prose are Markdown (tasks fn, sz); human
	// prompts and background Bash output stay literal. A memo preserves DOM.
	let md = createMemo(() => {
		let item = props.row.item
		return item.type === 'text' || item.type === 'thinking' || item.type === 'output' ||
			(item.type === 'prompt' && !!item.from && !/^bash (?:#t?\d+|b[0-9a-f]{6})$/.test(item.label ?? ''))
	})
	let markdown = () => (
		<Markdown text={shown()?.text ?? ''} streaming={props.cursor}>
			<Show when={props.cursor}>{cursor()}</Show>
		</Markdown>
	)
	// A prompt's [image/<name>] markers are links (task qy), rebuilt only
	// when its text changes, not when a snapshot brings a new row object.
	let text = createMemo(() => shown()?.text ?? '')
	let linked = createMemo(() => (props.row.item.type === 'prompt' && text().includes('[image/') ? hrefs.links(text()) : text()))
	let parts = () => {
		let l = linked()
		return typeof l === 'string' ? l : l.map((p) => (typeof p === 'string' ? p : <a href={external(p.href)} target="_blank" rel="noopener">{p.text}</a>))
	}
	let time = () => titles.time((props.row.item as { ts?: string }).ts)
	// A history rewrite's divider (task z71) offers its undo.
	let undo = () => props.row.item.type === 'divider' && props.row.item.text.startsWith('History rewritten · /rebase undo ·')
	let edit = () => {
		if (!editPrompt.edit(props.row.waiting ? props.row.key : props.row.item.key)) return
		flush()
		let box = document.querySelector<HTMLTextAreaElement>('.Composer textarea')
		box?.focus()
		box?.setSelectionRange(box.value.length, box.value.length)
	}
	let editButton = () => <Show when={props.edit}><button type="button" class="edit" aria-label={props.row.waiting ? 'Edit queued message' : 'Edit prompt'} title={props.row.waiting ? 'Edit in the queue without changing its position' : 'Edit this prompt and send it again from here'} onClick={edit}><Icon name="edit" /></button></Show>
	// Drops this queued message by its inbox id (task gr4); the host refuses with a visible reason.
	let discardButton = () => <Show when={props.discard}><button type="button" class="discard" aria-label="Discard queued message" title="Remove from the queue" onClick={() => app.sendNow({ type: 'submit', sessionId: props.session, text: `/queue drop ${props.row.key}` })}><Icon name="close" /></button></Show>
	let heading = () => (
		<CardHeader icon={titles.letter(props.row.item) === 'm' ? 'message' : undefined} time={time()} label={who()} reference={link()}>
			{editButton()}
			{discardButton()}
		</CardHeader>
	)
	// Content branches share the shell, header and normal body inset.
	let plain = (s: () => { kind: string; text: string }) => (
		<>
			<Show when={title()} fallback={link()}>{heading()}</Show>
			<div class="content">
				<Show when={props.row.item.type === 'image' && props.row.item} fallback={md() ? markdown() : props.row.item.type === 'prompt' && source() ? marked(s().text) : parts()}>
					{(img) => <a href={hrefs.blobUrl(props.session, img().blob)} target="_blank" rel="noopener" title="Open image in a separate tab to zoom"><img src={hrefs.blobUrl(props.session, img().blob)} alt={s().text} /></a>}
				</Show>
				<Show when={props.cursor && !md()}>{cursor()}</Show>
				<Show when={undo()}><button type="button" class="undo" title="Restore the history before this rewrite (/rebase undo)" onClick={() => app.sendNow({ type: 'submit', sessionId: props.session, text: '/rebase undo' })}><Icon name="undo" />Undo</button></Show>
			</div>
		</>
	)
	// A prompt-file change (task ar): the terminal's rows in its diff
	// colors, no header; open, each change's line and whole diff.
	let tone = (r: string) => (r[0] === '+' ? 'add' : r[0] === '-' ? 'del' : 'dim')
	// An item never turns into a change or out of one.
	let isChange = () => props.row.item.type === 'output' && !!props.row.item.change
	let change = () => (
		<>
			{link()}
			<div class="content diff change">
				<For each={promptChanges.rows(props.row.item)}>{(r) => <div class={`row ${r.tone}`}>{r.parts ? <For each={r.parts}>{(w, k) => <>{k() ? ' ' : ''}<span class={w.tone}>{w.text}</span></>}</For> : r.text}</div>}</For>
				<Show when={expanded()}>
					<For each={promptChanges.run(props.row.item)}>
						{(o) => <><div class="head">{promptChanges.line(o)}</div><div class="lines"><For each={o.change!.diff.split('\n')}>{(r) => <div class={tone(r)}>{r}</div>}</For></div></>}
					</For>
				</Show>
			</div>
		</>
	)
	// A queued message's compact row (task 16): its note and text, no
	// header, at most 3 lines until a click (or its link) opens it.
	let queued = () => {
		let all = `${props.row.note} ${text()}`.split('\n')
		return expanded() || all.length <= 3 ? all.join('\n') : [...all.slice(0, 3), `… ${all.length - 3} more lines`].join('\n')
	}
	let compact = () => (
		<>
			<Show when={expanded() && md()} fallback={<>{link()}{editButton()}{discardButton()}<div class="content">{queued()}</div></>}>
				{heading()}
				<div class="content"><div class="sender">{props.row.note}</div>{markdown()}</div>
			</Show>
		</>
	)
	return (
		<Show when={shown()}>
			{(s) => (
				<article ref={(e) => (root = e)} class={['Card', ...s().kind.split(' '), props.row.pending ? 'pending' : '', props.row.note !== undefined ? 'queued' : '', folding() ? 'folds' : '', expanded() && !closable() ? 'open' : '', props.target ? 'target' : '']} onClick={toggle}>
					<Show when={props.row.note === undefined} fallback={compact()}>
						{isChange() ? change() : (
						<Show when={folding()} fallback={plain(s)}>
							<CardHeader icon={kindIcon()} time={time()} name={props.row.item.type === 'thinking' && !expanded() ? `${titles.who(props.row.item)}: ${head()}` : head()} open={expanded()} reference={link()}
								label={<For each={headerParts()}>{(part) => typeof part === 'string' ? part : <a href={external(part.href)} target="_blank" rel="noopener noreferrer">{part.text}</a>}</For>}>
								<Show when={props.cursor && !open()}>{cursor()}</Show>
								<Show when={props.row.item.type === 'tool' && toolDetails.unsafe(props.row.item.name, props.row.item.input)}><span class="unsafe">unsafe to stop</span></Show>
								<Show when={props.row.result && bashResult.interrupted(props.row.result)}>{(s) => <span class="status">({s()})</span>}</Show>
								<Show when={failed()}><span class="error">✗</span></Show>
								<Show when={props.job}>{(n) => <button type="button" class="kill" title={`Stop background job #t${n()} (/kill #t${n()})`} onClick={() => app.sendNow({ type: 'submit', sessionId: props.session, text: `/kill #t${n()}` })}><Icon name="stop" />kill</button>}</Show>
							</CardHeader>
							<div class="body" inert={!expanded()}>
								<div class="contents">
									<div class="content">
										<Show when={props.row.item.type === 'prompt'}><div class="sender">{who()}</div></Show>
										{md() ? markdown() : body()}
										<Show when={props.cursor && !md()}>{cursor()}</Show>
										<Show when={long()}><button type="button" class="more" onClick={more}><Icon name={full() ? 'less' : 'more'} />{full() ? 'show less' : 'show all'}</button></Show>
									</div>
								</div>
							</div>
						</Show>
						)}
					</Show>
				</article>
			)}
		</Show>
	)
}
