// The terminal client: one session's transcript above an editable
// prompt. Keys become commands to the host (through the connection), and every
// event from the host is folded into the transcript and shown. Nothing
// here waits on the host. The prompt is the session's draft, kept and
// shared through common/drafts.ts; a sent prompt shows at once, pending
// until the host has it. It shows the host's tabs and one focused tab
// (src/client/tabs.ts); each tab keeps its own client state meanwhile.
// Tasks: b3, tr, p0, rqq.

import { queueEdit } from '../common/queue-edit.ts'
import { queuedPrompt } from './queue-edit.ts'
import { amend, type Editing } from '../common/amend.ts'
import { backfill, type Backfill } from '../common/backfill.ts'
import { completion } from '../common/completion.ts'
import { connection, type LinkState } from '../common/connection.ts'
import { forms, type FormState } from '../common/forms.ts'
import { drafts } from '../common/drafts.ts'
import { modals, type ModalAction, type ModalState } from '../common/modals.ts'
import type { Delivery, Event, Tab } from '../common/protocol.ts'
import { states } from '../common/states.ts'
import { transcript, type Transcript } from '../common/transcript.ts'
import { uploads } from '../common/uploads.ts'
import { ansi } from './ansi.ts'
import type { KeyEvent } from './keys.ts'
import { prompt, type PromptState } from '../common/prompt.ts'
import { recall } from '../common/recall.ts'
import { render } from './render.ts'
import { rebaseEditor } from './rebase-editor.ts'
import { terminal } from './terminal.ts'
import { clientCommands } from './commands.ts'
import { markdown } from '../common/markdown.ts'
import { frame } from './frame.ts'
import { paste } from './paste.ts'
import { pulse } from './pulse.ts'
import { halCursor } from './hal-cursor.ts'
import { promptKeys, type Clip } from './prompt-keys.ts'
import type { Focus } from './tabs.ts'
import { tabSwitch, type TabView } from './tab-switch.ts'
import { appView } from './app-view.ts'
import { appModals } from './app-modals.ts'
import { titles } from '../common/titles.ts'
import { notices } from '../common/notices.ts'
import { find } from './find.ts'
import { sendKeys } from '../common/send-keys.ts'
import type { Hint } from './help-row.ts'
import { command as restart } from './commands/restart.ts'

// `form`: the session's open question as filled in here; while there is
// one, keys go to it instead of the prompt.
// `editing`: the last prompt is in the editor (src/common/amend.ts).
// `modal`: client-only UI; onModal submits, onModalKey (if set) takes
// its keys instead of modals.step (the picker's tree keys).
// `choices`: tab completion's, listed below the prompt until a key.
// `tabs`: the host's, in order; `focus`: the one shown; `asked`: the tab
// this client's own tab command named, focused once it is in the list;
// `hidden`: the client state of tabs not shown. `start`: where a starting
// client looks for its tab (a restart: the one it left; remote: no cwd).
// `away`: the window reported losing focus; `watching`: the visibility
// last told the host (tab-switch.ts watch).
export type AppState = {
	away?: boolean
	watching?: string
	tabs: Tab[]
	focus: Focus
	asked?: string
	hidden: Map<string, TabView>
	start: { cwd?: string; last?: string }
	transcript?: Transcript
	prompt: PromptState
	notice?: string
	form?: FormState
	editing?: Editing
	modal?: ModalState
	onModal?: (action: Extract<ModalAction, { type: 'submit' }>, modal: ModalState) => unknown
	onModalKey?: (modal: ModalState, key: KeyEvent) => ReturnType<typeof modals.step>
	older: Map<string, Backfill>; background: Set<string>; painted: boolean; loading?: string; timer?: ReturnType<typeof setTimeout>; typing?: ReturnType<typeof setTimeout>; choices?: string[] | Hint[]
}

function createState(): AppState {
	return { tabs: [], focus: {}, hidden: new Map(), start: { cwd: '/' }, prompt: prompt.empty(), older: new Map(), background: new Set(), painted: false }
}

// Paints the view; the pulse beats while something in it blinks.
// A rotating example (the prompt's, or a form field's) repaints when
// its text next changes, on the pulse's frame grid.
function show(): void {
	let v = appView.view()
	pulse.keep(appView.blinks(v) ? app.beat : null)
	render.show(v)
	let st = app.state
	clearTimeout(st.typing)
	let f = st.form ?? st.modal?.form
	let now = pulse.now()
	let next = Math.min(v.placeholder?.next ?? Infinity, ...(f?.values.map((v, i) => (v ? Infinity : forms.example(f, i, now).next)) ?? []))
	if (next === Infinity) return
	st.typing = setTimeout(app.show, pulse.until(next))
	;(st.typing as { unref?: () => void }).unref?.()
}

// A beat of the pulse: a repaint, if a blink changed.
function beat(): void {
	let v = appView.view()
	if (appView.blinks(v) !== appView.blinks(render.state.view)) render.show(v)
}

function onEvent(event: Event): void {
	let st = app.state
	let queueChanged = queueEdit.onEvent(event)
	if (event.type === 'rebase-result') return rebaseEditor.result(event, (text) => { st.notice = text; app.show() })
	if (event.type === 'rebase-plan') return void rebaseEditor.open(event, app.send, (text) => { st.notice = text; app.show() })
	if (event.type === 'find-results') return find.event(event)
	// A recalled entry stays on screen; the draft changes underneath.
	let mine = st.transcript && 'sessionId' in event && event.sessionId === st.transcript.meta.id ? event.sessionId : undefined
	if (drafts.onEvent(event) && mine && !recall.shown(mine) && !st.editing?.queueEdit) app.setPrompt(drafts.text(mine))
	// An upload landed; a submit waiting for it goes now.
	let resume = paste.settled(st, event)?.resume
	// Replayed as the chord bound to its delivery, so remapped keys hold (task 8kx).
	let chord = resume && sendKeys.key(resume.delivery)
	if (resume && mine) app.onKeys([{ key: 'enter', shift: false, alt: chord === 'alt-enter', ctrl: chord === 'ctrl-enter', cmd: chord === 'cmd-enter' }])
	if (event.type === 'auth' && event.link !== undefined) ansi.state.web = { url: event.link, code: event.code }
	if (event.type === 'model-names') titles.learn(event)
	if (event.type === 'tabs') {
		if (event.sessions) markdown.state.sessions = new Set(event.sessions)
		return app.onTabs(event.tabs)
	}
	if (event.type === 'notice') return notices.add(notices.fromEvent(event))
	if (event.type === 'restart') return restart.withHost()
	if (event.type === 'restart-ask') return restart.ask(event, app.open)
	if (event.type === 'redraw' || event.type === 'toggle' || event.type === 'paste-text') return clientCommands.event(event)
	if (event.type === 'go') {
		if (st.focus.tab !== event.sessionId || !st.tabs.some((tab) => tab.id === event.tab)) return
		if (event.block) find.aim({ sessionId: event.tab, blockId: event.block.replace(/^[a-z]/, '') })
		app.focusOn({ tab: event.tab })
		find.seek()
		return app.show()
	}
	if (event.type === 'ack' && event.tab !== undefined) {
		st.asked = event.tab
		return app.onTabs(st.tabs)
	}
	let shown = st.focus.tab
	if (shown !== undefined && 'sessionId' in event && event.sessionId !== undefined && event.sessionId !== shown) return tabSwitch.hiddenEvent(event)
	if (event.type === 'rejected') st.notice = `${event.command} refused: ${event.reason}`
	else if (event.type === 'warning') st.notice = event.text
	else if (event.type === 'completions') app.completed(event)
	else if (event.type === 'models') app.pick(event)
	else if (event.type === 'settings') app.configure(event)
	else {
		let t = transcript.fold(st.transcript, event)
		st.transcript = t
		if (event.type === 'snapshot' || event.type === 'history') app.backfilled(event)
		if (event.type === 'snapshot' && t) app.setPrompt(queueEdit.editing(t.meta.id) ? queueEdit.text(t.meta.id) : recall.shown(t.meta.id) ?? drafts.text(t.meta.id))
		st.form = forms.follow(st.form, transcript.question(t))
	}
	queuedPrompt.sync(st, event)
	if (queueChanged?.notice) st.notice = queueChanged.notice
	app.show()
	find.seek()
	if (event.type === 'snapshot' && event.sessionId === shown) st.painted = true
	if (st.loading === shown && event.type === 'snapshot') delete st.loading
	app.backgroundStep()
}

// Earlier history is fetched in the background, shown all at once.
function backfilled(event: Event & { type: 'snapshot' | 'history' }): void {
	let out = backfill.fetchAll(app.state.older, app.state, event)
	// A task apart: an in-process host answers at once, holding off keys.
	if (out.command) setTimeout(app.send, 0, out.command)
	Object.assign(app.state, out.view)
}

// Every connection brings the tabs; tab-start asks the host to name the
// tab to show: the focused one if any, else the start's.
function onState(state: LinkState): void {
	if (state.type !== 'connected') queueEdit.disconnected()
	restart.linkChanged()
	let st = app.state
	st.notice = state.type === 'connected' ? undefined : 'host lost; reconnecting…'
	// A new connection's host knows nothing this client watched.
	delete st.watching
	if (state.type === 'connected') {
		let tab = app.focusedTab()
		let last = tab?.id ?? st.start.last, cwd = tab?.cwd ?? st.start.cwd
		let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
		app.send({ type: 'tab-start', ...(cwd === undefined ? {} : { cwd }), ...(last === undefined ? {} : { last }), ...(timezone ? { timezone } : {}) })
		// A code for the web links this terminal prints (task e3).
		app.send({ type: 'auth', link: true })
		app.sendScreen()
	}
	app.show()
}

// Enter: a prompt (steering a busy turn as `delivery` says, task csn),
// an edit of the last prompt, or a continue on an empty prompt. Refuses (keeping the typed text) what the host would refuse anyway.
function submit(text: string, delivery: Delivery = 'steer'): boolean {
	let st = app.state
	let id = st.transcript?.meta.id
	if (id && queueEdit.current(id)?.active) {
		queueEdit.input(id, text)
		st.notice = queueEdit.save(id)
		queuedPrompt.sync(st)
		return false
	}
	if (clientCommands.typed(text)) return true
	if (!st.transcript) {
		if (!text.trim()) return true
		st.notice = 'no session yet'
		return false
	}
	if (uploads.pending(st.transcript.meta.id)) {
		uploads.wait(st.transcript.meta.id, delivery)
		st.notice = 'sending once the upload is done'
		return false
	}
	if (!st.editing && !text.trim() && delivery === 'steer') text = states.nudge(st.transcript.state) ?? text
	// While editing the last prompt, Enter sends the edit.
	let { command, refused } = st.editing
		? { command: amend.enter(st.editing, st.transcript, text, delivery === 'queue'), refused: undefined }
		: states.enter(st.transcript.meta.id, st.transcript.state, text, delivery, st.transcript.inbox.some((m) => m.delivery === 'after-turn'))
	if (refused) {
		st.notice = refused
		return false
	}
	st.editing = undefined
	if (command) {
		st.notice = undefined
		let c = command as { type: string; text?: string; delivery?: Delivery; amend?: boolean; edits?: string }
		if (c.type === 'submit') drafts.submit(st.transcript.meta.id, c.text!, c)
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
	if (!event.items.length || st.notice === 'no completions') st.notice = event.items.length ? undefined : 'no completions'
	// Described candidates (task 4qh) list one per row.
	st.choices = choices && event.descriptions ? choices.map((c, i): Hint => [c, event.descriptions![i]!]) : choices
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
		if (k.key === 'focus-in' || k.key === 'focus-out') {
			st.away = k.key === 'focus-out'
			tabSwitch.watch()
			continue
		}
		delete st.choices
		// Tab and command keys, whatever has the keys.
		if (app.tabKey(k) || clientCommands.key(k)) continue
		if (st.modal) {
			let { state, action } = st.onModalKey ? st.onModalKey(st.modal, k) : modals.step(st.modal, k)
			st.modal = state
			if (!action) continue
			// A /config change: sent, the modal stays open.
			if (action.type === 'send') { app.send(action.command); continue }
			let submit = st.onModal
			app.close()
			let command = action.type === 'submit' ? submit?.(action, state) : undefined
			if (command) app.send(command)
			continue
		}
		find.target = undefined
		if (st.form && st.transcript) {
			let { state, action } = forms.step(st.form, k)
			st.form = state
			if (action) app.send(forms.command(st.transcript.meta.id, state, action))
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
		// A pasted image path or long text: its upload's placeholder.
		// Undo on an empty prompt with nothing to undo takes back a message sent early (task csn).
		let undo = !k.shift && !k.alt && ((k.ctrl && k.key === '/') || (k.cmd && (k.key === 'z' || k.key === 'u')))
		if (undo && st.transcript && !st.prompt.text && !st.prompt.undo?.length && states.promoted(st.transcript.inbox)) {
			drafts.submit(st.transcript.meta.id, '/queue undo')
			continue
		}
		let key = st.transcript ? paste.key(st.transcript.meta.id, k, app.send) : k
		if (key.key === 'paste' && key.text) {
			let start = prompt.selection(st.prompt)?.start ?? st.prompt.cursor
			key = { ...key, text: uploads.pad(key.text, st.prompt.text.slice(0, start)) }
		}
		let { state, action } = prompt.step(st.prompt, key, frame.promptWidth(app.cols()))
		if (action?.type === 'submit' && !app.submit(action.text, action.delivery)) continue
		// An in-process /go can focus another session during submit (qhz).
		if (st.transcript?.meta.id !== shown) continue
		let edited = state.text !== st.prompt.text && action?.type !== 'submit'
		st.prompt = state
		let id = st.transcript?.meta.id
		if (edited && id && !queueEdit.input(id, state.text) && recall.typed(id, state.text)) drafts.edit(id, state.text)
		// A recalled entry was sent: the user's own text comes back.
		if (action?.type === 'submit' && id && recall.stop(id)) app.setPrompt(drafts.text(id))
		let pause = action?.type === 'cancel' && st.transcript && states.escape(st.transcript.meta.id, st.transcript.state)
		if (pause) app.send(pause)
		if (action?.type === 'quit') return terminal.quit()
	}
	app.show()
}

// The clipboard for session `id`: text or an image's upload pasted if
// the session is still shown, a failure told.
function pasted(id: string | undefined, r: Clip): void {
	if ('notice' in r) return ((app.state.notice = r.notice), app.show())
	if (!id || app.state.transcript?.meta.id !== id) return
	let text = 'image' in r ? paste.upload(id, 'image/png', r.image, app.send) : r.text
	app.onKeys([{ key: 'paste', text, shift: false, alt: false, ctrl: false, cmd: false }])
}

// Takes keys from the terminal and paints the first frame. Idempotent.
function init(): void {
	terminal.onKeys = (events) => app.onKeys(events)
	terminal.onScreen = () => app.sendScreen()
	notices.onChange = () => app.show()
	app.show()
}

// The terminal's size and kind, for the host's inspect tool.
function sendScreen(): void {
	let size = terminal.state.io?.size()
	if (!size) return
	let env = process.env
	let term = [env.TERM, [env.TERM_PROGRAM, env.TERM_PROGRAM_VERSION].filter(Boolean).join(' '), env.COLORTERM].filter(Boolean).join(', ').slice(0, 200)
	app.send({ type: 'screen', cols: size.cols, rows: size.rows, ...(term ? { term } : {}) })
}

function reset(): void {
	if (app.state.modal?.find) find.close()
	find.state = { filters: [...find.state.filters] }
	find.target = undefined
	if (app.state.timer) clearTimeout(app.state.timer)
	app.state = createState()
	pulse.reset()
	halCursor.reset()
	drafts.reset()
	recall.reset()
	queueEdit.disconnected()
	uploads.reset()
	notices.reset()
}

export const app = {
	state: createState(),
	send: (command: unknown): void => connection.send(command),
	/** The terminal's width, which Up/Down move by. */
	cols: (): number => render.state.out?.size().cols ?? 80,
	show,
	beat,
	onEvent,
	backgroundStep: tabSwitch.backgroundStep,
	backfilled,
	onState,
	focusedTab: tabSwitch.focusedTab,
	onTabs: tabSwitch.onTabs,
	focusOn: tabSwitch.focusOn,
	tabKey: tabSwitch.tabKey,
	// Told the tab shown after every change (main.ts keeps it for a restart).
	focused: (_tab: Tab): void => {},
	submit,
	completed,
	setPrompt,
	onKeys,
	open: appModals.open,
	close: appModals.close,
	pick: appModals.pick,
	configure: appModals.configure,
	pasted,
	init,
	reset,
	sendScreen,
}
