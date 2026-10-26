/// <reference lib="dom" />
// Draws one transcript row as a card in its theme colors (view.show). A
// card starts short (its title row) or long, as the session starts its
// kind (task hyt); the header switches the two. Only header taps
// collapse an open card. Hidden contents are inert. The height animates
// in CSS; scroll.ts tracks the bottom meanwhile. `cursor`: the card
// streams, so Hal's cursor follows its last character (in the header
// while a folding card is closed). Whether a card is open is kept by its
// session and row key (task w5), not by its DOM, so no other item's card
// ever shows open in its place.
// Tasks: w5, 6eq, 18n, kx0, hyt, bp1.
// Every card links to itself (target.ts, task 0z); `target`: the
// address links here, so the card is marked and opens. An open tool
// card shows all of its result; the transcript holds all of it (host
// tools cap what they keep), so nothing is fetched.

import { Prose } from './Prose.tsx'
import { interruption } from '../../common/interruption.ts'
import { createEffect, createMemo, createSignal, onSettled, Show, untrack } from 'solid-js'
import { CardActivity } from './CardActivity.tsx'
import { LinkedText } from './LinkedText.tsx'
import { CardText } from './CardText.tsx'
import { CardReceipt } from './CardReceipt.tsx'
import { cardIcons } from '../card-icons.ts'
import { cardMotion } from '../card-motion.ts'
import { bashResult } from '../../common/bash-result.ts'
import { card } from '../../common/card.ts'
import { forms } from '../../common/forms.ts'
import { markdown as parser } from '../../common/markdown.ts'
import { titles } from '../../common/titles.ts'
import { toolDetails } from '../../common/tool-details.ts'
import { transcript } from '../../common/transcript.ts'
import { Markdown } from './Markdown.tsx'
import { CardActions } from './CardActions.tsx'
import { CardHeader } from './CardHeader.tsx'
import { CardReference } from './CardReference.tsx'
import { PromptChanges } from './PromptChanges.tsx'
import { ToolBody } from './ToolBody.tsx'
import { promptChanges } from '../../common/prompt-changes.ts'
import { cardRows } from '../card-rows.ts'
import { target } from '../target.ts'
import { view } from '../view.ts'
import type { Row } from '../transcript-rows.ts'
import { hrefs } from '../hrefs.ts'
import { folds } from '../folds.ts'
import { toggle as blockToggle } from '../../common/toggle.ts'
import type { Verbosity } from '../../common/card.ts'
import type { SessionMeta } from '../../common/session.ts'

// An image row shows the image itself, from the session's blob.
// `job`: the background job this Bash call started still runs; a Kill
// button in the header sends /kill #<job>.
// `edit`: a prompt the user may edit and resend; its header offers Edit
// (task 26q, edit-prompt.ts), which loads it into the box.
// `waiting`: a wait title as text and links (toolDetails.waiting).
export function Card(props: {
	row: Row
	session: string
	cursor?: boolean
	target?: boolean
	job?: string
	edit?: boolean
	discard?: boolean
	blocks?: SessionMeta['blocks']
	running?: { call: string; since?: string }
	waiting?: (title: string) => ReturnType<typeof hrefs.urlParts> | undefined
}) {
	// A job's streaming card folds apart from its call's (task 6nn).
	let id = () => `${props.session}#${props.row.job ? props.row.key : props.row.item.key}`
	let root: HTMLElement | undefined
	onSettled(() => root && cardMotion.enter(root))
	let bash = () =>
		!!bashResult.background(props.row.item) || (props.row.item.type === 'tool' && props.row.item.name === 'bash')
	let background = () => !!bashResult.background(props.row.item)
	let backgroundCommand = () => {
		let command = props.row.call?.input.command
		return typeof command === 'string' ? command : undefined
	}
	let resultTime = () => (props.row.result ? titles.resultTime(props.row.item.ts, props.row.result.ts) : '')
	// Short or long (task hyt): as the session starts its kind, until a
	// click, /toggle or Ctrl-O switches it; a call fails with its result.
	let level = () =>
		folds.level(
			id(),
			folds.start(
				props.session,
				props.row.item,
				card.initial(props.row.item, props.blocks, card.failed(props.row.result, bash())),
			),
		)
	let open = () => level() === 'long'
	// The setters may run in an effect: they read the state as of the call.
	let setLevel = (fold: Verbosity) =>
		untrack(() => folds.set(id(), fold, [props.row.item.key, ...(props.row.result ? [props.row.result.key] : [])]))
	// Replies and the user's prompts read as plain cards until collapsed
	// (task r4d); a collapsed one folds like thinking.
	let closable = () => ['prompt', 'text'].includes(card.kind(props.row.item) ?? '')
	let expanded = open
	// The call the session runs; it keeps its state (task hyt): its
	// header shows its time, spinner and, short, its latest output line.
	let running = () => props.row.item.type === 'tool' && props.running?.call === props.row.item.id
	let live = () => !!props.cursor || running()
	let since = () => (running() ? props.running?.since : undefined) ?? (props.row.item as { ts?: string }).ts
	let spins = () => ['thinking', 'text', 'tool'].includes(props.row.item.type)
	let limit = () => {
		let item = props.row.item
		return item.type === 'tool' ? toolDetails.limit(item.name, item.input) : undefined
	}
	let activity = () => <CardActivity live={live()} since={since()} spins={spins()} limit={limit()} />
	let latest = () => {
		let item = props.row.item
		return item.type === 'tool' && running() && !open()
			? item.partial
					?.split('\n')
					.findLast((l) => l.trim())
					?.trim()
			: undefined
	}
	let fullCommand = () => {
		let item = props.row.item
		return item.type === 'tool' && toolDetails.fullCommand(item.name, item.input)
	}
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
	let href = () =>
		props.row.pending || (props.row.waiting && props.row.note === undefined)
			? undefined
			: target.href(props.session, blockId())
	let outputLines = createMemo(() => (expanded() ? cardRows.outputLines(props.row.item, result()?.text) : undefined))
	let reference = () => link()
	let link = () => (
		<CardReference href={href()} id={blockId()}>
			<CardReceipt row={props.row} />
		</CardReference>
	)

	// Another session's message with a summary folds under it.
	// Prompt-file changes fold under their summary (task ar).
	let folding = () =>
		props.row.note === undefined && blockToggle.toggles(props.row.item) && (!closable() || !expanded())
	// A tool's first line (its description or call) heads the card;
	// thinking is headed by the terminal's header words and its first
	// line. Prompts and model text show those words above their text
	// (task hp).
	let source = () => props.row.item.type === 'prompt' && props.row.item.label?.match(/^bash #?(t?\d+)$/)?.[1]
	let who = () => {
		let item = props.row.item
		// A question is headed by its text, its addresses links.
		if (item.type === 'question') return <LinkedText parts={hrefs.urlParts(forms.title(item.form))} />
		let ref = source(),
			t = titles.who(item)
		if (titles.letter(item) === 'm') t = cardIcons.unmark(t)
		let shown = ref && (/^\d+$/.test(ref) ? `t${ref}` : ref)
		return shown && t?.endsWith(shown) ? (
			<>
				{t.slice(0, -shown.length)}
				<a class="call" href={transcript.href(props.session, shown)} title="Go to Bash call">
					{shown}
				</a>
			</>
		) : (
			t
		)
	}
	let lines = () => (shown()?.text ?? '').split('\n')
	// A commit's first line heads its card; the body omits it.
	let firstLine = () => {
		let item = props.row.item
		return item.type === 'output' ? item.text.split('\n')[0] : ''
	}
	let presentation = () =>
		props.row.result?.presentationError
			? undefined
			: (props.row.result?.presentation ?? (props.row.item.type === 'tool' ? props.row.item.presentation : undefined))
	let presentationError = () =>
		props.row.result?.presentationError ??
		(props.row.item.type === 'tool' ? props.row.item.presentationError : undefined)
	// An open message without a summary is headed by its sender, as in
	// the terminal; its text then shows once, in the body.
	let headsWho = () => props.row.item.type === 'prompt' && !props.row.item.summary && expanded()
	let head = () => {
		let item = props.row.item
		if (background())
			return backgroundCommand() === undefined ? titles.who(item) : `${titles.who(item)}: $ ${backgroundCommand()}`
		if (item.type === 'thinking') {
			let first = expanded()
				? ''
				: parser
						.inline(lines().find((line) => line.trim()) ?? '', !!props.cursor)
						.map((r) => r.text)
						.join('')
						.trim()
			return first ? `${first}${item.originSession ? ` (in ${item.originSession})` : ''}` : titles.who(item)
		}
		if (item.type === 'prompt' || item.type === 'text')
			return expanded() && !(item.type === 'prompt' && item.summary) ? titles.who(item) : titles.compact(item)
		if (item.type === 'output' && item.change) return item.text.split('\n')[0]
		if (item.type === 'output' && item.commit) return `${titles.who(item)} ${firstLine()}`
		return item.type === 'tool'
			? cardIcons.unmark(
					presentation()?.title ?? toolDetails.headline(item.name, item.input, props.row.result?.output).text,
					item.name,
				)
			: lines()[0]
	}
	let shellPrompt = () => (props.row.item.type === 'tool' && props.row.item.name === 'bash' ? '$ ' : undefined)
	// A wait links what it waits for (task zd8).
	let waitParts = () => {
		let item = props.row.item
		return item.type === 'tool' && !presentation()?.title && toolDetails.headline(item.name, item.input).mark === 'wait'
			? props.waiting?.(head() ?? '')
			: undefined
	}
	let headerParts = createMemo(() => waitParts() ?? hrefs.urlParts(head() ?? ''))
	// A closed reply or prompt: its sender in the title color, its text
	// in the body color it has open, as a closed Bash card shows output.
	let compactParts = createMemo(() => {
		let h = head() ?? '',
			w = titles.who(props.row.item) ?? ''
		return w && h.startsWith(`${w}: `) ? { who: `${w}:`, text: hrefs.urlParts(h.slice(w.length + 2)) } : undefined
	})
	let call = createMemo(() => {
		let item = props.row.item
		if (item.type !== 'tool') return []
		let lines = toolDetails.lines(item.name, item.input),
			command = item.input.command
		return item.name === 'bash' &&
			!presentation() &&
			!presentationError() &&
			!item.input.description &&
			typeof command === 'string' &&
			!command.includes('\n')
			? lines.slice(1)
			: lines
	})
	let body = () => (prose() ? parts() : lines().join('\n'))
	let failed = () =>
		!!presentationError() || !!props.row.result?.isError || (props.row.item.type === 'output' && !!props.row.item.error)
	let clicks = cardMotion.toggler({
		root: () => root,
		canToggle: () => canToggle(),
		expanded: () => expanded(),
		disclose: () =>
			untrack(() =>
				folds.disclose(id(), level(), [props.row.item.key, ...(props.row.result ? [props.row.result.key] : [])]),
			),
	})
	let cursor = () => <span class="cursor" aria-hidden="true" />
	// Model text and inter-tab prose are Markdown (tasks fn, sz); human
	// prompts and background Bash output stay literal. A memo preserves DOM.
	let md = createMemo(() => card.markdown(props.row.item))
	let interrupted = () => {
		let item = props.row.item
		return item.type === 'text' && item.interrupted ? interruption.tail(item.text) : ''
	}
	let markdown = () => (
		<Markdown
			text={shown()?.text ?? ''}
			interruption={interrupted()}
			streaming={props.cursor}
			links={
				props.row.item.type === 'text' || props.row.item.type === 'thinking'
					? parser.blockLinks(props.session, props.row.key)
					: undefined
			}
		>
			<Show when={props.cursor}>{cursor()}</Show>
		</Markdown>
	)
	// A prompt's [image/<name>] markers are links (task qy), rebuilt only
	// when its text changes, not when a snapshot brings a new row object.
	let text = createMemo(() => shown()?.text ?? '')
	// Body columns, measured when the pointer enters the card; until then
	// a 14px monospace estimate.
	let [cols, setCols] = createSignal(Math.max(20, Math.floor(innerWidth / 8.4)))
	let measure = () => {
		let header = root?.querySelector<HTMLElement>(':scope > .CardHeader')
		if (header) setCols(cardRows.columns(header))
	}
	// The rows opening a closed card adds, shown faintly on hover: a tool's
	// command, a blank row, then its whole output, wrapped like the
	// terminal; a closed thinking card already shows its first line. A
	// presented tool result has no count, rather than a wrong one.
	let peek = createMemo(() => {
		if (expanded() || !folding() || closable()) return undefined
		let item = props.row.item
		if (item.type === 'tool') {
			if (presentation() || presentationError()) return undefined
			let r = props.row.result
			let output = (r ? (view.show(r, true, bash())?.text ?? '') : (item.partial ?? '')).replace(/\n$/, '')
			let command = call().length ? cardRows.rows(call().join('\n'), cols()) : 0
			return command + (command && output ? 1 : 0) + (output ? cardRows.rows(output, cols()) : 0)
		}
		let body =
			bashResult.background(item) && item.type === 'prompt'
				? bashResult.display(item.text).replace(/\n$/, '')
				: text().trim()
		return body ? cardRows.rows(body, cols()) - (item.type === 'thinking' ? 1 : 0) : 0
	})
	let prose = () =>
		props.row.item.type === 'prompt' &&
		!md() &&
		!bashResult.background(props.row.item) &&
		props.row.item.origin !== 'model'
	let parts = () => (prose() ? <Prose text={text()} /> : <CardText item={props.row.item} text={text()} />)
	let time = () => titles.time((props.row.item as { ts?: string }).ts)
	let statusResult = () => {
		let item = props.row.item
		return item.type === 'prompt' && background()
			? { output: item.text }
			: expanded() && resultTime() && (result()?.text || presentation())
				? undefined
				: props.row.result
	}
	let isChange = createMemo(() => props.row.item.type === 'output' && !!props.row.item.change)
	let queued = createMemo(() => props.row.note !== undefined)
	let changes = createMemo(() => (isChange() ? promptChanges.rows(props.row.item) : []))
	let unstamp = (text: string) => (time() && text.startsWith(time()!) ? text.slice(time()!.length).trimStart() : text)
	let oneRow = createMemo(
		() =>
			['turn-end', 'divider'].includes(props.row.item.type) ||
			(props.row.item.type === 'command' && props.row.item.from === undefined && props.row.item.output === undefined),
	)
	let canToggle = () => blockToggle.toggles(props.row.item) || props.row.note !== undefined || closable()
	let headerLabel = () => {
		if (background())
			return backgroundCommand() === undefined ? (
				who()
			) : (
				<>
					{who()}: $ {backgroundCommand()}
				</>
			)
		if (isChange()) return unstamp(changes()[0]?.text ?? '')
		if (props.row.note !== undefined)
			return (
				<>
					{unstamp(props.row.note)}
					<Show when={!expanded()}>
						{' '}
						<span class="secondary">{titles.preview(text())}</span>
					</Show>
				</>
			)
		if (oneRow()) return <LinkedText parts={hrefs.urlParts(unstamp(text()))} />
		if (closable())
			return (
				<Show when={!expanded()} fallback={who()}>
					<Show when={compactParts()} fallback={<LinkedText parts={headerParts()} />}>
						{(c) => (
							<>
								{c().who}{' '}
								<span class="secondary">
									<LinkedText parts={c().text} />
								</span>
							</>
						)}
					</Show>
				</Show>
			)
		if (!folding()) return who()
		if (headsWho()) return who()
		return (
			<Show
				when={props.row.item.type === 'output' && props.row.item.commit}
				fallback={<LinkedText parts={headerParts()} />}
			>
				{titles.who(props.row.item)} <span class="secondary">{firstLine()}</span>
			</Show>
		)
	}
	let content = (s: () => { kind: string; text: string }) => {
		if (oneRow()) return null
		if (isChange())
			return (
				<Show when={expanded()}>
					<PromptChanges item={props.row.item} />
				</Show>
			)
		if (queued())
			return (
				<Show when={expanded()}>
					<div class="content">{md() ? markdown() : parts()}</div>
				</Show>
			)
		return (
			<Show
				when={folding()}
				fallback={
					<div class="content">
						<div>
							<Show when={props.row.item.type === 'image' && props.row.item} fallback={md() ? markdown() : parts()}>
								{(img) => (
									<a
										href={hrefs.blobUrl(props.session, img().blob)}
										target="_blank"
										rel="noopener"
										title="Open image in a separate tab to zoom"
									>
										<img src={hrefs.blobUrl(props.session, img().blob)} alt={s().text} />
									</a>
								)}
							</Show>
							<Show when={props.cursor && !md()}>{cursor()}</Show>
						</div>
					</div>
				}
			>
				<div class="body" inert={!expanded()}>
					<div class="contents">
						<div class="content">
							<Show
								when={props.row.item.type !== 'tool'}
								fallback={
									<>
										{md() ? (
											markdown()
										) : (
											<Show when={expanded() || !presentation()}>
												<ToolBody
													row={props.row}
													id={id()}
													full={full()}
													bash={bash()}
													result={result()}
													presentation={presentation()}
													presentationError={presentationError()}
													call={call()}
													failed={failed()}
												/>
											</Show>
										)}
										<Show when={props.cursor && !md()}>{cursor()}</Show>
									</>
								}
							>
								<div>
									<Show when={props.row.item.type === 'prompt' && !background() && !headsWho()}>
										<div class="sender">{who()}</div>
									</Show>
									{md() ? markdown() : body()}
									<Show when={props.cursor && !md()}>{cursor()}</Show>
								</div>
							</Show>
						</div>
					</div>
				</div>
			</Show>
		)
	}
	return (
		<Show when={shown()}>
			{(s) => (
				<article
					ref={(e) => (root = e)}
					class={[
						'Card',
						...s().kind.split(' '),
						bashResult.background(props.row.item) ? 'background-result' : '',
						props.row.pending ? 'pending' : '',
						props.row.note !== undefined ? 'queued' : '',
						folding() ? 'folds' : '',
						expanded() ? 'open' : '',
						props.cursor ? 'streaming' : '',
						props.target ? 'target' : '',
					]}
					onClick={clicks.click}
					onPointerEnter={measure}
					onMouseDown={clicks.press}
				>
					<CardHeader
						icon={cardIcons.kind(props.row.item)}
						prefix={shellPrompt()}
						time={time()}
						name={canToggle() ? (head() ?? titles.who(props.row.item) ?? 'Card') : undefined}
						open={expanded()}
						label={headerLabel()}
						hidden={closable() && !expanded() ? titles.hidden(props.row.item) : 0}
						peek={peek()}
						result={statusResult()}
						bash={bash()}
						allExits={background()}
						limit={limit()}
						lines={outputLines()}
						reference={reference()}
						activity={activity()}
						actions={
							<CardActions
								row={props.row}
								session={props.session}
								edit={props.edit}
								discard={props.discard}
								job={props.job}
							/>
						}
					>
						<Show when={props.cursor && !open()}>{cursor()}</Show>
						<Show
							when={props.row.item.type === 'tool' && toolDetails.unsafe(props.row.item.name, props.row.item.input)}
						>
							<span class="unsafe">unsafe to stop</span>
						</Show>
						<Show when={failed()}>
							<span class="error">×</span>
						</Show>
						<Show when={latest()}>{(l) => <span class="latest">{l()}</span>}</Show>
					</CardHeader>
					{content(s)}
				</article>
			)}
		</Show>
	)
}
