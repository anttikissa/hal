// The terminal client: one session's transcript above an editable
// prompt. Keys become commands to the host (through the connection), and every
// event from the host is folded into the transcript and shown. Nothing
// here waits on the host. The prompt is the session's draft, kept and
// shared through common/drafts.ts; a sent prompt shows at once, pending
// until the host has it. It shows the host's tabs and one focused tab
// (src/client/tabs.ts); each tab keeps its own client state meanwhile.

import { amend, type Editing } from '../common/amend.ts'
import { backfill, type Backfill } from '../common/backfill.ts'
import { completion } from '../common/completion.ts'
import { connection, type LinkState } from '../common/connection.ts'
import { forms, type FormState } from '../common/forms.ts'
import { drafts } from '../common/drafts.ts'
import { modals, type ModalAction, type ModalState } from '../common/modals.ts'
import { picker } from '../common/picker.ts'
import { placeholders } from '../common/placeholders.ts'
import type { Event, Tab } from '../common/protocol.ts'
import { states } from '../common/states.ts'
import { transcript, type Resumed, type Transcript } from '../common/transcript.ts'
import type { KeyEvent } from './keys.ts'
import { prompt, type PromptState } from '../common/prompt.ts'
import { recall } from '../common/recall.ts'
import { render } from './render.ts'
import { terminal } from './terminal.ts'
import { frame, type View } from './frame.ts'
import { promptKeys } from './prompt-keys.ts'
import { tabs, type Focus } from './tabs.ts'

// `resumed`: where the history of the last snapshot ends, marked on screen.
// `form`: the session's open question as filled in here; while there is
// one, keys go to it instead of the prompt.
// `editing`: the last prompt is in the editor (src/common/amend.ts).
// `modal`: client-only UI over everything, taking the keys first;
// `onModal` makes the command its Enter sends; `onModalKey` updates it
// after a key (the picker refilters its list).
// `tabs`: the host's, in order; `focus`: the one shown; `asked`: the tab
// this client's own tab command named, focused once it is in the list;
// `hidden`: the client state of tabs not shown. `start`: where a
// starting client looks for its tab (a restart: the one it left).
type AppState = {
	tabs: Tab[]
	focus: Focus
	asked?: string
	hidden: Map<string, TabView>
	start: { cwd: string; last?: string }
	transcript?: Transcript
	resumed?: Resumed
	prompt: PromptState
	notice?: string
	form?: FormState
	editing?: Editing
	modal?: ModalState
	onModal?: (action: Extract<ModalAction, { type: 'submit' }>, modal: ModalState) => unknown
	onModalKey?: (modal: ModalState) => ModalState
	older: Map<string, Backfill>
}

// What each tab keeps while another is shown.
type TabView = Pick<AppState, 'transcript' | 'resumed' | 'prompt' | 'notice' | 'form' | 'editing'>
const tabFields = ['transcript', 'resumed', 'prompt', 'notice', 'form', 'editing'] as const

function createState(): AppState {
	return { tabs: [], focus: {}, hidden: new Map(), start: { cwd: '/' }, prompt: prompt.empty(), older: new Map() }
}

function view(): View {
	let st = app.state
	let v: View = { prompt: st.prompt }
	if (st.transcript) v.transcript = st.transcript
	if (st.resumed) v.resumed = st.resumed
	let pending = st.transcript ? drafts.pending(st.transcript.meta.id) : []
	if (pending.length) v.pending = pending
	if (st.form) v.form = st.form
	if (st.modal) v.modal = st.modal
	// An example request for an empty prompt, another each turn.
	let t = st.transcript
	if (t && !st.prompt.text) v.placeholder = placeholders.pick(t.meta.cwd, app.halDir(), t.items.filter((i) => i.type === 'prompt').length)
	if (st.tabs.length) v.tabs = st.focus.tab === undefined ? { list: st.tabs } : { list: st.tabs, focused: st.focus.tab }
	// A passing notice, else what the session is doing.
	let notice = st.notice ?? (st.editing ? amend.hint() : st.transcript && states.describe(st.transcript.state))
	if (notice) v.notice = notice
	return v
}

function show(): void {
	render.show(app.view())
}

function onEvent(event: Event): void {
	let st = app.state
	// Text typed before the first session arrived joins its draft.
	let early = !st.transcript && event.type === 'snapshot' ? st.prompt.text : ''
	// A recalled entry stays on screen; the draft changes underneath.
	let mine = st.transcript && 'sessionId' in event && event.sessionId === st.transcript.meta.id ? event.sessionId : undefined
	if (drafts.onEvent(event) && mine && !recall.shown(mine)) app.setPrompt(drafts.text(mine))
	if (event.type === 'tabs') return app.onTabs(event.tabs)
	if (event.type === 'ack' && event.tab !== undefined) {
		st.asked = event.tab
		return app.onTabs(st.tabs)
	}
	// Late events of a tab just left are not this view's.
	let shown = st.focus.tab
	if (shown !== undefined && 'sessionId' in event && event.sessionId !== undefined && event.sessionId !== shown) return
	if (event.type === 'rejected') st.notice = `${event.command} refused: ${event.reason}`
	else if (event.type === 'warning') st.notice = event.text
	else if (event.type === 'completions') app.completed(event)
	else if (event.type === 'models') app.pick(event)
	else {
		let t = transcript.fold(st.transcript, event)
		if (event.type === 'snapshot' && t && t !== st.transcript) st.resumed = transcript.resumed(event.snapshot, t)
		// An edited prompt may have replaced what the mark was after.
		if (st.resumed && t && st.resumed.at > t.items.length) st.resumed = { ...st.resumed, at: t.items.length }
		st.transcript = t
		if (event.type === 'snapshot' || event.type === 'history') app.backfilled(event)
		if (event.type === 'snapshot' && t) {
			let id = t.meta.id
			if (early) drafts.edit(id, drafts.text(id) ? `${drafts.text(id)}\n${early}` : early)
			app.setPrompt(recall.shown(id) ?? drafts.text(id))
		}
		st.form = forms.follow(st.form, transcript.question(t))
	}
	app.show()
}

// Earlier history is fetched in the background, shown all at once.
function backfilled(event: Event & { type: 'snapshot' | 'history' }): void {
	let out = backfill.fetchAll(app.state.older, app.state, event)
	if (out.command) app.send(out.command)
	Object.assign(app.state, out.view)
}

// On every connection the host names the tab to show and sends the tabs:
// the focused one if any, else the start's.
function onState(state: LinkState): void {
	let st = app.state
	st.notice = state.type === 'connected' ? undefined : 'host lost; reconnecting…'
	if (state.type === 'connected') {
		let tab = app.focusedTab()
		let last = tab?.id ?? st.start.last
		app.send({ type: 'tab-start', cwd: tab?.cwd ?? st.start.cwd, ...(last === undefined ? {} : { last }) })
	}
	app.show()
}

function focusedTab(): Tab | undefined {
	return app.state.tabs.find((t) => t.id === app.state.focus.tab)
}

// The host's tabs changed, or named the tab this client asked for.
function onTabs(list: Tab[]): void {
	let st = app.state
	let old = st.tabs.map((t) => t.id)
	let ids = list.map((t) => t.id)
	st.tabs = list
	let asked = st.asked
	if (asked !== undefined && ids.includes(asked)) delete st.asked
	for (let id of st.hidden.keys()) if (!ids.includes(id)) st.hidden.delete(id)
	app.focusOn(tabs.focus(old, ids, st.focus, asked))
	app.show()
}

// Shows `focus`: the tab left keeps its client state and is no longer
// followed, the tab shown is followed and its state comes back. A modal
// closes. A tab shown that wants attention is told seen.
function focusOn(focus: Focus): void {
	let st = app.state
	let from = st.focus.tab
	st.focus = focus
	if (focus.tab !== from) {
		if (from !== undefined) {
			let kept = {} as TabView
			for (let f of tabFields) if (st[f] !== undefined) Object.assign(kept, { [f]: st[f] })
			st.hidden.set(from, kept)
			app.send({ type: 'close', sessionId: from })
		}
		for (let f of tabFields) delete st[f]
		let back = focus.tab === undefined ? undefined : st.hidden.get(focus.tab)
		Object.assign(st, { prompt: prompt.empty() }, back)
		delete st.modal
		delete st.onModal
		delete st.onModalKey
		if (focus.tab !== undefined) {
			st.hidden.delete(focus.tab)
			if (!back) app.setPrompt(recall.shown(focus.tab) ?? drafts.text(focus.tab))
			app.send({ type: 'open', sessionId: focus.tab })
		}
	}
	let tab = app.focusedTab()
	if (tab) app.focused(tab)
	if (tab?.attention) app.send({ type: 'tab-seen', sessionId: tab.id })
}

// Tab keys: new, reopen, close, next, previous, go to 1-10. True if
// handled.
function tabKey(k: KeyEvent): boolean {
	let st = app.state
	let tab = app.focusedTab()
	if (k.cmd || !tab) return false
	let go = (id: string | undefined) => {
		if (id !== undefined && id !== tab.id) app.focusOn({ tab: id })
		return true
	}
	let ids = st.tabs.map((t) => t.id)
	if (k.ctrl && !k.alt) {
		if (k.key === 't') app.send(k.shift ? { type: 'tab-resume' } : { type: 'tab-new', cwd: tab.cwd, after: tab.id })
		else if (k.shift) return false
		else if (k.key === 'w') app.send({ type: 'tab-close', sessionId: tab.id })
		else if (k.key === 'n' || k.key === 'p') return go(tabs.step(ids, tab.id, k.key === 'n' ? 1 : -1))
		else return false
		return true
	}
	if (k.alt && !k.ctrl && !k.shift && /^[0-9]$/.test(k.key)) return go(ids[(Number(k.key) + 9) % 10])
	return false
}

// Enter: a prompt (steering a busy turn; `queue`: after it), an edit
// of the last prompt, or a continue on an empty prompt. Refuses (keeping the typed text) what the
// host would refuse anyway.
function submit(text: string, queue = false): boolean {
	let st = app.state
	if (!st.transcript) {
		if (!text.trim()) return true
		st.notice = 'no session yet'
		return false
	}
	// While editing the last prompt, Enter sends the edit.
	let { command, refused } = st.editing
		? { command: amend.enter(st.editing, st.transcript, text, queue), refused: undefined }
		: states.enter(st.transcript.meta.id, st.transcript.state, text, queue)
	if (refused) {
		st.notice = refused
		return false
	}
	st.editing = undefined
	if (command) {
		st.notice = undefined
		let c = command as { type: string; text?: string; queue?: boolean; amend?: boolean }
		if (c.type === 'submit') drafts.submit(st.transcript.meta.id, c.text!, c.queue, c.amend)
		else app.send(command)
	}
	return true
}

// The host's completions for the prompt, if it still says what was sent.
function completed(event: Event & { type: 'completions' }): void {
	let st = app.state
	if (st.transcript?.meta.id !== event.sessionId || st.prompt.text !== event.text) return
	let { text, choices } = completion.apply(event.text, event.items)
	app.setPrompt(text)
	if (text !== event.text) drafts.edit(event.sessionId, text)
	st.notice = choices ? choices.join('  ') : event.items.length ? undefined : 'no completions'
}

// Puts `text` in the prompt, unless it is there already (the cursor
// stays where the user left it); a selection goes.
function setPrompt(text: string): void {
	let st = app.state
	if (st.prompt.text === text) return
	let { anchor: _, typed: _t, ...rest } = st.prompt
	st.prompt = { ...rest, text, cursor: text.length }
}

function onKeys(events: KeyEvent[]): void {
	let st = app.state
	for (let k of events) {
		if (app.tabKey(k)) continue
		// Ctrl-L: repaint everything, whatever has the keys.
		if (k.key === 'l' && k.ctrl && !k.alt && !k.shift && !k.cmd) {
			terminal.redraw()
			continue
		}
		if (st.modal) {
			let { state, action } = modals.step(st.modal, k)
			st.modal = state
			if (!action && st.onModalKey) st.modal = st.onModalKey(state)
			if (!action) continue
			let submit = st.onModal
			app.close()
			let command = action.type === 'submit' ? submit?.(action, state) : undefined
			if (command) app.send(command)
			continue
		}
		if (st.form && st.transcript) {
			let { state, action } = forms.step(st.form, k)
			st.form = state
			if (action) app.send(forms.command(st.transcript.meta.id, state, action))
			continue
		}
		// Ctrl-M: the model picker, once the host has sent the list.
		if (k.key === 'm' && k.ctrl && !k.alt && !k.cmd && st.transcript) {
			app.send({ type: 'models', sessionId: st.transcript.meta.id })
			continue
		}
		if (promptKeys.edit(st, k, app.send)) continue
		let shown = st.transcript?.meta.id
		if (promptKeys.clip(st, k, (r) => app.pasted(shown, r))) continue
		// Tab at the end of a slash command: the host completes it.
		let tab = k.key === 'tab' && !k.shift && st.transcript && st.prompt.cursor === st.prompt.text.length && !prompt.selection(st.prompt)
		let complete = tab && completion.request(st.transcript!.meta.id, st.prompt.text)
		if (complete) {
			app.send(complete)
			continue
		}
		if (promptKeys.history(st, k, frame.promptWidth(app.cols()))) continue
		let { state, action } = prompt.step(st.prompt, k, frame.promptWidth(app.cols()))
		if (action?.type === 'submit' && !app.submit(action.text, action.queue)) continue
		let edited = state.text !== st.prompt.text && action?.type !== 'submit'
		st.prompt = state
		let id = st.transcript?.meta.id
		if (edited && id && recall.typed(id, state.text)) drafts.edit(id, state.text)
		// A recalled entry was sent: the user's own text comes back.
		if (action?.type === 'submit' && id && recall.stop(id)) app.setPrompt(drafts.text(id))
		let pause = action?.type === 'cancel' && st.transcript && states.escape(st.transcript.meta.id, st.transcript.state)
		if (pause) app.send(pause)
		if (action?.type === 'quit') return terminal.quit()
	}
	app.show()
}

// The clipboard for session `id`: text pasted if the session is still
// shown, a failure told.
function pasted(id: string | undefined, r: { text: string } | { notice: string }): void {
	if ('notice' in r) return ((app.state.notice = r.notice), app.show())
	if (app.state.transcript?.meta.id === id) app.onKeys([{ key: 'paste', text: r.text, shift: false, alt: false, ctrl: false, cmd: false }])
}

// Opens `modal` over everything. Enter closes it and sends what
// `submit` makes of it (nothing if undefined); Escape just closes it.
function open(modal: ModalState, submit: NonNullable<AppState['onModal']>, onKey?: AppState['onModalKey']): void {
	app.state.modal = modal
	app.state.onModal = submit
	if (onKey) app.state.onModalKey = onKey
	else delete app.state.onModalKey
	app.show()
}

function close(): void {
	delete app.state.modal
	delete app.state.onModal
	delete app.state.onModalKey
	app.show()
}

// The host's model list: the picker for this session, if it is on screen.
function pick(event: Event & { type: 'models' }): void {
	if (app.state.transcript?.meta.id !== event.sessionId) return
	let id = event.sessionId
	app.open(
		picker.open(event.current, event.items),
		(action, modal) => picker.command(id, modal, action),
		(modal) => picker.refilter(modal, event.items),
	)
}

// Takes keys from the terminal and paints the first frame. Idempotent.
function init(): void {
	terminal.onKeys = (events) => app.onKeys(events)
	app.show()
}

function reset(): void {
	app.state = createState()
	drafts.reset()
	recall.reset()
}

export const app = {
	state: createState(),
	send: (command: unknown): void => connection.send(command),
	/** The terminal's width, which Up/Down move by. */
	cols: (): number => render.state.out?.size().cols ?? 80,
	/** The Hal repo's root, which has its own placeholders. */
	halDir: (): string => import.meta.dir.replace(/\/src\/client$/, ''),
	view,
	show,
	onEvent,
	backfilled,
	onState,
	focusedTab,
	onTabs,
	focusOn,
	tabKey,
	// Told the tab shown after every change (main.ts keeps it for a
	// restart).
	focused: (_tab: Tab): void => {},
	submit,
	completed,
	setPrompt,
	onKeys,
	open,
	close,
	pick,
	pasted,
	init,
	reset,
}
