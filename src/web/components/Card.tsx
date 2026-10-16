/// <reference lib="dom" />
// Tasks: w5, 6eq, 18n, kx0, hyt, bp1. One transcript row as a card in its theme colors (view.show). A
// card starts short (its title row) or long, as the session starts its
// kind (task hyt); the header switches the two.
// Only header taps collapse an open card. Hidden contents are inert. The height
// animates in CSS; scroll.ts tracks the bottom meanwhile. `cursor`:
// the card streams, so Hal's cursor follows its last character (in the
// header while a folding card is closed). Whether a card is open is
// kept by its session and row key (task w5), not by its DOM, so no other
// item's card ever shows open in its place.
// Every card links to itself (target.ts, task 0z); `target`: the
// address links here, so the card is marked and opens. An open tool
// card shows all of its result; the transcript holds all of it (host
// tools cap what they keep), so nothing is fetched.

import { ToolPresentation } from './ToolPresentation.tsx'
import { Thinking } from './Thinking.tsx'
import { Prose } from './Prose.tsx'
import { ToolCommand } from './ToolCommand.tsx'
import { interruption } from '../../common/interruption.ts'
import { diff } from '../../common/diff.ts'
import { createEffect, createMemo, createSignal, flush, For, onSettled, Show, untrack } from 'solid-js'
import { bashResult } from '../../common/bash-result.ts'
import { card } from '../../common/card.ts'
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
import { router } from '../router.ts'
import { folds } from '../folds.ts'
import { forms } from '../../common/forms.ts'
import { toggle as blockToggle } from '../../common/toggle.ts'
import type { Verbosity } from '../../common/card.ts'
import type { SessionMeta } from '../../common/session.ts'

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
const toolIcons: Record<string, IconName> = { read: 'read', edit: 'edit', write: 'edit', google: 'google', send: 'message', wait: 'wait', command: 'command', inspect: 'inspect', notify: 'notify', ask: 'ask', read_blob: 'blob', stop: 'stop', help: 'inspect' }
// A title without its leading mark ($, <, =>, …): the icon shows it.
const unmark = <T extends string | undefined>(title: T): T => title?.replace(/^(?:<=|=>|[$<>…!x?]) /, '') as T

// `describe`: a short title for a job (t248) or session id a wait names.
export function Card(props: { row: Row; session: string; cursor?: boolean; target?: boolean; job?: string; edit?: boolean; discard?: boolean; blocks?: SessionMeta['blocks']; running?: { call: string; since?: string }; describe?: (ref: string) => string | undefined }) {
	let id = () => `${props.session}#${props.row.item.key}`
	let root: HTMLElement | undefined
	onSettled(() => root && enter(root))
	let bash = () => !!bashResult.background(props.row.item) || (props.row.item.type === 'tool' && props.row.item.name === 'bash')
	// Short or long (task hyt): as the session starts its kind, until a
	// click, /toggle or Ctrl-O switches it; a call fails with its result.
	let level = () => folds.level(id(), card.initial(props.row.item, props.blocks, card.failed(props.row.result, bash())))
	let open = () => level() === 'long'
	// The setters may run in an effect: they read the state as of the call.
	let setLevel = (fold: Verbosity) => untrack(() => folds.set(id(), fold, [props.row.item.key, ...(props.row.result ? [props.row.result.key] : [])]))
	// Replies and the user's prompts read as plain cards until collapsed
	// (task r4d); a collapsed one folds like thinking.
	let closable = () => ['prompt', 'text'].includes(card.kind(props.row.item) ?? '')
	let expanded = open
	// The call the session runs; it keeps its state (task hyt): its
	// header shows its time, spinner and, short, its latest output line.
	let running = () => props.row.item.type === 'tool' && props.running?.call === props.row.item.id
	let live = () => !!props.cursor || running()
	let [now, setNow] = createSignal(Date.now())
	createEffect(live, (on) => {
		if (!on) return
		setNow(Date.now())
		let t = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(t)
	})
	let elapsed = () => { let ts = Date.parse((running() ? props.running?.since : undefined) ?? (props.row.item as { ts?: string }).ts ?? ''); return live() && Number.isFinite(ts) ? bashResult.duration(now() - ts, true) : undefined }
	let spins = () => ['thinking', 'text', 'tool'].includes(props.row.item.type)
	let limit = () => { let item = props.row.item; return item.type === 'tool' ? toolDetails.limit(item.name, item.input) : undefined }
	let activity = () => <Show when={spins()}><span class="ticker"><Show when={elapsed()}>{(e) => <span class="elapsed">({e()}{limit() ? ` / ${limit()}` : ''})</span>}</Show><span class={['spinner', live() ? 'on' : '']} aria-hidden="true" /></span></Show>
	let latest = () => { let item = props.row.item; return item.type === 'tool' && running() && !open() ? item.partial?.split('\n').findLast((l) => l.trim())?.trim() : undefined }
	let fullCommand = () => { let item = props.row.item; return item.type === 'tool' && toolDetails.fullCommand(item.name, item.input) }
	let full = () => fullCommand() || open()
	createEffect(
		() => props.target,
		(on) => {
			if (on) setLevel('long')
		},
	)
	let shown = () => view.show(props.row.item)
	let result = () => props.row.result && view.show(props.row.result, full(), bash())
	// The link shows the block's id, t35, as the terminal does. Its
	// text is drawn by CSS from data-ref, so copying the card's text
	// leaves it out.
	let blockId = () => titles.blockId(props.row.item)
	let href = () => (props.row.pending || (props.row.waiting && props.row.note === undefined) ? undefined : target.href(props.session, blockId()))
	let receipt = () => props.row.pending ? 0 : titles.receipt(props.row.item)
	let receiptLabel = () => receipt() === 1 ? 'Delivered, not read yet' : `Read by Hal${time() ? ` at ${time()}` : ''}`
	let ticks = () => <Show when={receipt()}><span class="receipt" role="img" aria-label={receiptLabel()} title={receiptLabel()}><Icon name={receipt() === 1 ? 'check' : 'checks'} /></span></Show>
	let outputLines = createMemo(() => {
		if (!expanded()) return undefined
		let item = props.row.item
		let output = item.type === 'tool' ? result()?.text ?? item.partial ?? '' : bashResult.background(item) && item.type === 'prompt' ? bashResult.display(item.text) : undefined
		return output === undefined ? undefined : output ? output.replace(/\n$/, '').split('\n').length : 0
	})
	let reference = () => <><Show when={outputLines() !== undefined}><span class="status line-count">({outputLines()} {outputLines() === 1 ? 'line' : 'lines'})</span></Show>{link()}</>
	let link = () => (
		<Show when={href()} fallback={ticks()}>
			{(h) => (
				<a class="link" href={h()} data-ref={blockId()} title="Link to this card" aria-label={`Link to card ${blockId()}`}>{ticks()}</a>
			)}
		</Show>
	)

	// Another session's message with a summary folds under it.
	// Prompt-file changes fold under their summary (task ar).
	let folding = () => props.row.note === undefined && blockToggle.toggles(props.row.item) && (!closable() || !expanded())
	// A tool's first line (its description or call) heads the card;
	// thinking is headed by the terminal's header words and its first
	// line. Prompts and model text show those words above their text
	// (task hp).
	let title = () => titles.title(props.row.item)
	let source = () => props.row.item.type === 'prompt' && props.row.item.label?.match(/^bash #?(t?\d+)$/)?.[1]
	let who = () => {
		let item = props.row.item
		// A question is headed by its text, its addresses links.
		if (item.type === 'question') return <For each={hrefs.urlParts(item.form.text)}>{(part) => typeof part === 'string' ? part : <a href={external(part.href)} target="_blank" rel="noopener noreferrer">{part.text}</a>}</For>
		let ref = source(), t = titles.who(item)
		if (titles.letter(item) === 'm') t = unmark(t)
		return ref && t?.endsWith(ref) ? <>{t.slice(0, -ref.length)}<a class="call" href={transcript.href(props.session, ref)} title="Go to Bash call">{ref}</a></> : t
	}
	let lines = () => (shown()?.text ?? '').replace(/^▸ /, '').split('\n')
	let presentation = () => props.row.result?.presentationError ? undefined : props.row.result?.presentation ?? (props.row.item.type === 'tool' ? props.row.item.presentation : undefined)
	let presentationError = () => props.row.result?.presentationError ?? (props.row.item.type === 'tool' ? props.row.item.presentationError : undefined)
	// An open message without a summary is headed by its sender, as in
	// the terminal; its text then shows once, in the body.
	let headsWho = () => props.row.item.type === 'prompt' && !props.row.item.summary && expanded()
	let head = () => {
		let item = props.row.item
		// Closed thinking spends its width on the preview, not a label.
		// Open cards keep the effort header; controls retain a named kind.
		if (item.type === 'thinking') {
			let first = expanded() ? '' : parser.inline(lines().find((line) => line.trim()) ?? '', !!props.cursor).map((r) => r.text).join('').trim()
			return first ? `${first}${item.originSession ? ` (in ${item.originSession})` : ''}` : titles.who(item)
		}
		if (item.type === 'prompt' || item.type === 'text') return expanded() && !(item.type === 'prompt' && item.summary) ? titles.who(item) : titles.compact(item)
		if (item.type === 'output' && item.change) return item.text.split('\n')[0]
		if (item.type === 'output' && item.commit) return `${titles.who(item)} ${lines()[0]}`
		return item.type === 'tool' ? unmark(presentation()?.title ?? toolDetails.headline(item.name, item.input, props.row.result?.output).text) : lines()[0]
	}
	// Folded cards name their kind with an icon: thinking, another
	// session's message or command (the send tool's bubble, which
	// unfolded ones show too), or the tool. Bash shows the terminal's
	// `$ ` as copyable text instead (task ya1); Python bash, its logo.
	let pythonBash = () => { let item = props.row.item; return item.type === 'tool' && item.name === 'bash' && typeof item.input.command === 'string' && runsPython.test(item.input.command) }
	let kindIcon = (): IconName | undefined => {
		let item = props.row.item
		if (item.type === 'thinking') return 'thinking'
		if (titles.letter(item) === 'm') return 'message'
		if (item.type !== 'tool') return undefined
		return pythonBash() ? 'python' : toolIcons[item.name]
	}
	let shellPrompt = () => props.row.item.type === 'tool' && props.row.item.name === 'bash' && !pythonBash() ? '$ ' : undefined
	// A wait names what it waits for: each job or session links to its
	// card or tab, with its title when known.
	let waitParts = () => {
		let item = props.row.item, h = head() ?? ''
		if (item.type !== 'tool' || presentation()?.title || toolDetails.headline(item.name, item.input).mark !== '…' || !h.startsWith('Waiting for ')) return undefined
		let parts: ReturnType<typeof hrefs.urlParts> = ['Waiting for ']
		h.slice('Waiting for '.length).split(', ').forEach((ref, i) => {
			if (i) parts.push(', ')
			let job = ref.match(/^#?t(\d+)$/)?.[1]
			let href = job ? transcript.href(props.session, `t${job}`) : /^\d+-[a-z]+$/.test(ref) ? router.format(ref) : undefined
			let about = href && props.describe?.(ref)
			parts.push(href ? { href, text: ref } : ref)
			if (about) parts.push(` (${about})`)
		})
		return parts
	}
	let headerParts = createMemo(() => waitParts() ?? hrefs.urlParts(head() ?? ''))
	let linkedParts = (parts: ReturnType<typeof hrefs.urlParts>) => <For each={parts}>{(part) => typeof part === 'string' ? part : part.href.startsWith('/') ? <a href={part.href}>{part.text}</a> : <a href={external(part.href)} target="_blank" rel="noopener noreferrer">{part.text}</a>}</For>
	// A closed reply or prompt: its sender in the title color, its text
	// in the body color it has open, as a closed Bash card shows output.
	let compactParts = createMemo(() => {
		let h = head() ?? '', w = titles.who(props.row.item) ?? ''
		return w && h.startsWith(`${w}: `) ? { who: `${w}:`, text: hrefs.urlParts(h.slice(w.length + 2)) } : undefined
	})
	let call = createMemo(() => { let item = props.row.item; return item.type === 'tool' ? toolDetails.lines(item.name, item.input) : [] })
	let command = <Show when={call().length}><ToolCommand lines={call()} compact={!full()} /></Show>
	let body = () => {
		let item = props.row.item
		if (item.type !== 'tool') return prose() ? parts() : lines().join('\n')
		if ((presentation() || presentationError()) && full()) return <>
			<Show when={presentationError()}>{(error) => <div class="error">{error()}</div>}</Show>
			<Show when={!presentation()}>{command}</Show>
			<Show when={props.row.result && (props.row.result.isError || props.row.result.interrupted || !presentation()) && props.row.result.output}>{(output) => <div class={props.row.result?.isError ? 'error' : ''}>{output()}</div>}</Show>
			<Show when={presentation()}>{(p) => <ToolPresentation presentation={p()} output={props.row.result?.output} />}</Show>
			<Show when={!props.row.result && item.partial}>{(output) => <div>{output()}</div>}</Show>
			<div class="raw-tool"><button type="button" aria-expanded={folds.raw().has(id()) ? 'true' : 'false'} onClick={() => folds.setRaw((s) => folds.toggled(s, id(), !s.has(id())))}>Raw call and result</button><Show when={folds.raw().has(id())}><pre>{item.cmd ?? toolDetails.value(item.input).join('\n')}{'\n\n'}{props.row.result?.output ?? item.partial ?? ''}</pre></Show></div>
		</>
		// An EDIT's diff shows its edits, so it stands alone, in diff colors.
		if (props.row.result?.diff) return <div class="edit-diff diff"><For each={result()!.text.split('\n')}>{(r) => <div class={diff.tone(r)}>{r}</div>}</For></div>
		// The call once (task 8t), then its output: the result, or what
		// has streamed so far.
		let out = result()?.text ?? item.partial?.replace(/\n$/, '')
		return <><Show when={presentationError()}>{(error) => <div class="error">{error()}</div>}</Show>{command}{out ? <span class={failed() ? 'result-text error' : 'result-text'}>{out}</span> : ''}</>
	}
	let failed = () => !!presentationError() || !!props.row.result?.isError || (props.row.item.type === 'output' && !!props.row.item.error)
	let toggle = (e: MouseEvent) => {
		let hit = e.target as Element
		let control = hit.closest('.mark, .CardHeader')
		if ((!folding() && props.row.note === undefined && !closable()) || hit.closest('a, .command-toggle, .kill, .edit, .send, .discard, .undo, .raw-tool')) return
		if (!control && expanded()) return
		scroll.follow(() => {
			untrack(() => folds.disclose(id(), level(), [props.row.item.key, ...(props.row.result ? [props.row.result.key] : [])]))
			flush()
		})
	}
	let cursor = () => <span class="cursor" aria-hidden="true" />
	// Model text and inter-tab prose are Markdown (tasks fn, sz); human
	// prompts and background Bash output stay literal. A memo preserves DOM.
	let md = createMemo(() => card.markdown(props.row.item))
	let interrupted = () => { let item = props.row.item; return item.type === 'text' && item.interrupted ? interruption.tail(item.text) : '' }
	let markdown = () => (
		<Markdown text={shown()?.text ?? ''} interruption={interrupted()} streaming={props.cursor} links={props.row.item.type === 'text' || props.row.item.type === 'thinking' ? parser.blockLinks(props.session, props.row.key) : undefined}>
			<Show when={props.cursor}>{cursor()}</Show>
		</Markdown>
	)
	// A prompt's [image/<name>] markers are links (task qy), rebuilt only
	// when its text changes, not when a snapshot brings a new row object.
	let text = createMemo(() => shown()?.text ?? '')
	let linked = createMemo(() => (props.row.item.type === 'prompt' && text().includes('[image/') ? hrefs.links(text()) : text()))
	let prose = () => props.row.item.type === 'prompt' && !md() && !bashResult.background(props.row.item) && props.row.item.origin !== 'model'
	let parts = () => {
		let item = props.row.item
		if (prose()) return <Prose text={text()} />
		// A past question keeps its quote's marks, as the open form showed them.
		if (item.type === 'question' && item.form.quote?.marks?.length) {
			let q = item.form.quote
			let indent = (t: string, marked: boolean) => t.split('\n').map((l, i) => <>{i ? '\n    ' : ''}{marked && l ? <mark>{l}</mark> : l}</>)
			return <>{'    '}<For each={forms.quoteParts(q)}>{(p) => indent(p.text, p.marked)}</For>{text().slice(q.text.length + 4 * q.text.split('\n').length)}</>
		}
		let l = linked()
		return typeof l === 'string' ? l : l.map((p) => (typeof p === 'string' ? p : <a href={external(p.href)} target="_blank" rel="noopener">{p.text}</a>))
	}
	let time = () => titles.time((props.row.item as { ts?: string }).ts)
	// A history rewrite's divider (task z71) offers its undo.
	let undo = () => (props.row.item.type === 'divider' && props.row.item.text.includes('`/rebase undo`'))
	let undoButton = () => <Show when={undo()}><button type="button" class="undo" title="Go back (/rebase undo)" onClick={() => app.sendNow({ type: 'submit', sessionId: props.session, text: '/rebase undo' })}><Icon name="undo" />Undo</button></Show>
	let edit = () => {
		if (!editPrompt.edit(props.row.waiting ? props.row.key : props.row.item.key)) return
		flush()
		let box = document.querySelector<HTMLTextAreaElement>('.Composer textarea')
		box?.focus()
		box?.setSelectionRange(box.value.length, box.value.length)
	}
	let editButton = () => <Show when={props.edit}><button type="button" class="edit" aria-label={props.row.waiting ? 'Edit queued message' : 'Edit prompt'} title={props.row.waiting ? 'Edit in the queue without changing its position' : 'Edit this prompt and send it again from here'} onClick={edit}><Icon name="edit" /></button></Show>
	// Drops this queued message by its inbox id (task gr4); the host refuses with a visible reason.
	let sendButton = () => <Show when={props.discard}><button type="button" class="send" aria-label="Send queued message now" title="Send now; it keeps its sender and arrival time" onClick={() => app.sendNow({ type: 'submit', sessionId: props.session, text: `/queue next ${props.row.key}` })}><Icon name="send" /></button></Show>
	let discardButton = () => <Show when={props.discard}><button type="button" class="discard" aria-label="Discard queued message" title="Remove from the queue" onClick={() => app.sendNow({ type: 'submit', sessionId: props.session, text: `/queue drop --id ${props.row.key}` })}><Icon name="close" /></button></Show>
	let statusResult = () => { let item = props.row.item; return item.type === 'prompt' && bashResult.background(item) ? { output: item.text } : props.row.result }
	let heading = () => (
		<CardHeader icon={titles.letter(props.row.item) === 'm' ? 'message' : undefined} time={time()} name={closable() ? folding() ? head() : titles.who(props.row.item) : undefined} open={expanded()} label={<Show when={closable() && folding()} fallback={<>{who()}</>}><Show when={compactParts()} fallback={linkedParts(headerParts())}>{(c) => <>{c().who} <span class="secondary">{linkedParts(c().text)}</span></>}</Show></Show>} result={statusResult()} bash={bash()} reference={reference()} actions={<>{editButton()}{discardButton()}</>} activity={activity()} />
	)
	// Content branches share the shell, header and normal body inset.
	let plain = (s: () => { kind: string; text: string }) => (
		<>
			<Show when={!closable()}><Show when={title()} fallback={link()}>{heading()}</Show></Show>
			<div class="content">
				<div>
					<Show when={props.row.item.type === 'image' && props.row.item} fallback={md() ? markdown() : parts()}>
						{(img) => <a href={hrefs.blobUrl(props.session, img().blob)} target="_blank" rel="noopener" title="Open image in a separate tab to zoom"><img src={hrefs.blobUrl(props.session, img().blob)} alt={s().text} /></a>}
					</Show>
					<Show when={props.cursor && !md()}>{cursor()}</Show>
					{undoButton()}
				</div>
			</div>
		</>
	)
	// A prompt-file change (task ar): the terminal's rows in its diff
	// colors, no header; open, each change's line and whole diff.
	let tone = diff.tone
	// An item never turns into a change or out of one.
	let isChange = () => props.row.item.type === 'output' && !!props.row.item.change
	let change = () => (
		<>
			{link()}
			<div class="content diff change">
				<For each={promptChanges.rows(props.row.item)}>{(r, i) => <Show when={i() === 0} fallback={<div class={`row ${r.tone}`}>{r.parts ? <For each={r.parts}>{(w, k) => <>{k() ? ' ' : ''}<span class={w.tone}>{w.text}</span></>}</For> : r.text}</div>}><button type="button" class="row head mark" aria-label={r.text} aria-expanded={expanded() ? 'true' : 'false'}><span class="disclosure" aria-hidden="true">▸</span>{r.text}</button></Show>}</For>
				<Show when={expanded()}>
					<For each={promptChanges.run(props.row.item)}>
						{(o) => <><div class="head">{promptChanges.line(o)}</div><div class="lines"><For each={o.change!.diff.split('\n')}>{(r) => <div class={tone(r)}>{r}</div>}</For></div></>}
					</For>
				</Show>
			</div>
		</>
	)
	// A queued message's compact row (task 16): its note and text, no
	// header, one line until a click (or its link) opens it.
	let queued = () => {
		let all = `${props.row.note} ${text()}`
		return expanded() ? all : (all.split('\n')[0] ?? '')
	}
	let compact = () => (
		<>
			<Show when={expanded() && md()} fallback={<>{link()}{editButton()}{sendButton()}{discardButton()}<div class={['content', expanded() ? '' : 'line']}>{expanded() && prose() ? <Prose text={queued()} /> : queued()}</div></>}>
				{heading()}
				<div class="content"><div class="sender">{props.row.note}</div>{markdown()}</div>
			</Show>
		</>
	)
	return (
		<Show when={shown()}>
			{(s) => (
				<article ref={(e) => (root = e)} style={{ '--ref-width': `${blockId().length}ch` }} class={['Card', ...s().kind.split(' '), bashResult.background(props.row.item) ? 'background-result' : '', props.row.pending ? 'pending' : '', props.row.note !== undefined ? 'queued' : '', folding() ? 'folds' : '', expanded() && !closable() ? 'open' : '', props.cursor ? 'streaming' : '', props.target ? 'target' : '']} onClick={toggle}>
					<Show when={props.row.item.type === 'thinking'} fallback={
					<Show when={props.row.note === undefined} fallback={compact()}>
						{isChange() ? change() : (
						<>
						<Show when={closable() && title()}>{heading()}</Show>
						<Show when={folding()} fallback={plain(s)}>
							<Show when={!closable()}>
							<CardHeader icon={kindIcon()} prefix={shellPrompt()} time={time()} name={props.row.item.type === 'thinking' && !expanded() ? `${titles.who(props.row.item)}: ${head()}` : head()} open={expanded()} result={statusResult()} bash={bash()} limit={limit()} reference={reference()} activity={activity()}
								actions={<>{undoButton()}<Show when={props.job}>{(n) => <button type="button" class="kill error" title={`Stop background job t${n()} (/kill t${n()})`} aria-label={`Kill background job t${n()}`} onClick={() => app.sendNow({ type: 'submit', sessionId: props.session, text: `/kill t${n()}` })}><Icon name="skull" />kill</button>}</Show></>}
								label={<Show when={headsWho()} fallback={<Show when={props.row.item.type === 'output' && props.row.item.commit} fallback={linkedParts(headerParts())}>{titles.who(props.row.item)} <span class="secondary">{lines()[0]}</span></Show>}>{who()}</Show>}>
								<Show when={props.cursor && !open()}>{cursor()}</Show>
								<Show when={props.row.item.type === 'tool' && toolDetails.unsafe(props.row.item.name, props.row.item.input)}><span class="unsafe">unsafe to stop</span></Show>
								<Show when={failed()}><span class="error">✗</span></Show>
								<Show when={latest()}>{(l) => <span class="latest">{l()}</span>}</Show>
							</CardHeader>
							</Show>
							<div class="body" inert={!expanded()}>
								<div class="contents">
									<div class="content">
										<Show when={props.row.item.type !== 'tool'} fallback={<>{md() ? markdown() : <Show when={expanded() || !presentation()}>{body()}</Show>}<Show when={props.cursor && !md()}>{cursor()}</Show></>}>
											<div>
												<Show when={props.row.item.type === 'prompt' && !headsWho()}><div class="sender">{who()}</div></Show>
												{md() ? markdown() : body()}
												<Show when={props.cursor && !md()}>{cursor()}</Show>
											</div>
										</Show>
									</div>
								</div>
							</div>
						</Show>
						</>
						)}
					</Show>
					}><Thinking text={s().text} open={expanded()} time={time() ?? ''} metadata={<>{activity()}{link()}</>}>{markdown()}</Thinking></Show>
				</article>
			)}
		</Show>
	)
}
