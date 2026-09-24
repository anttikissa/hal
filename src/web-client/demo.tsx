// Fast UI prototyping sandbox for the transcript, served at /demo/.
// Deliberately NOT covered by automated tests: iterate here quickly, test by hand in the
// browser, then port finished features to the real transcript one at a time.
// Each feature is tagged [F1]..[F16] at the code that implements it.
//
// [F1] Stable rows: <For keyed={id}> keeps each card's DOM and local state (open/closed)
//      even when every block object is replaced by a fresh snapshot.
// [F2] ID links: clicking a card's short ID opens and centers it without the browser's
//      native anchor jump; Cmd/Ctrl-click still opens a new tab.
// [F3] Deep link on load: a URL like /demo/#000009-pku opens and centers that card once,
//      when it first mounts. After that the URL never moves the scroll again.
// [F4] Bottom follow: if the reader is within 50px of the bottom when content grows,
//      keep them at the bottom. If they have scrolled up, leave the scroll alone.
// [F5] Bottom anchor on toggle: opening/closing a card while at the bottom keeps the
//      view pinned to the bottom, so the newly opened contents are visible.
// [F6] Exact bottom gap: within that 50px zone, keep the same distance from the bottom
//      (20px up stays 20px up) instead of snapping to the very bottom.
// [F7] Growing last block: streamed text makes the LAST block taller without appending a
//      new one. It goes through the same keepBottom() as appends, so [F4]/[F6] apply.
// [F8] Live -> saved handoff: a new block streams without an ID for a few seconds, then
//      gets its short ID when "saved". Keying rows by ID changes the key at that moment,
//      so Solid rebuilds the row and it CLOSES. Keying by index keeps the row, because the
//      transcript is append-only. Toggle the mode on the page to compare.
// [F9] Target highlight: the card named by the URL hash gets an outline. Wanted in the real app.
// [F10] Smooth follow: when a bottom reader follows a new block or a toggle, the new block
//      fades in over FADE_MS while the viewport glides (ease-out cubic) to where [F4]/[F6]
//      would jump. Streamed lines [F7] jump instantly: a glide over one line looked janky.
//      User scroll input cancels the glide; prefers-reduced-motion keeps the instant jump.
// [F11] Click anywhere on a card to toggle it; drag-selecting text and ID links don't toggle.
// [F12] Open/close animates the card's height (CSS grid 0fr <-> 1fr), so blocks below slide
//      instead of jumping. A bottom reader stays pinned by following the bottom every frame.
// [F13] Terminal-style composer: status line, input, and Send share one bottom panel.
// [F14] Status line mirrors the terminal's (Running bash…, Thinking…, Reconnecting…).
// [F15] Sending a message always glides to the very bottom, even when scrolled far up.
// [F16] A dedicated line after the last block holds Hal's blinking terminal cursor.
//      It stays visible when idle; orange normally, grey while thinking streams.
//      The user's textarea keeps its native browser caret.
import { createSignal, flush, For, onSettled, Show } from 'solid-js'
import { render } from '@solidjs/web'

const kinds = ['assistant', 'thinking', 'tool'] as const
// id is '' while the block is live (streaming); lines is how much text has streamed so far.
// [F13] 'user' blocks come only from the composer, carrying the typed text.
type Block = { id: string; kind: (typeof kinds)[number] | 'user'; updates: number; lines: number; text?: string }
const LINES_BEFORE_SAVE = 4
// [F10] Glide: short enough to feel instant, long enough for the eye to track the motion.
const ENTER_MS = 200
// [F10] Fade is twice the glide: at 150ms the fade was imperceptible.
const FADE_MS = 300
// [F12] Open/close height animation; 'track' follows the bottom for exactly this long.
const TOGGLE_MS = 250
const TICK_MS = 1_000
// Debug slow motion (demo only): multiplies tick, glide, fade, and toggle durations so motion is visible.
const [slow, setSlow] = createSignal(false)
function speed(): number {
	if (slow()) return 5
	return 1
}

// [F9] Current URL hash as a signal; only used for the highlight outline.
const [hash, setHash] = createSignal(location.hash.slice(1))
window.addEventListener('hashchange', () => setHash(location.hash.slice(1)))
window.addEventListener('popstate', () => setHash(location.hash.slice(1)))

// [F10] The running glide, if any. gap is the bottom distance it is heading for.
// [F15] forced marks a send-triggered glide, which user input must not cancel.
const glide = { frame: 0, gap: 0, forced: false }
function stopGlide(): void {
	cancelAnimationFrame(glide.frame)
	glide.frame = 0
}
// [F10] Any manual scroll input means the reader is taking over; never fight them.
// Only scroll keys count: any other key (like the demo's 's') would cancel the glide mid-way,
// so the next measurement sees a half-finished scroll, lands outside the 50px zone, and stops following.
// [F15] Except a send: macOS trackpad momentum keeps firing wheel events for a second or
// two after the fingers lift, which cancelled the send glide right after it started.
function userScroll(): void {
	if (!glide.forced) stopGlide()
}
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])
for (const type of ['wheel', 'touchstart']) window.addEventListener(type, userScroll, { passive: true })
window.addEventListener('keydown', (event) => { if (SCROLL_KEYS.has(event.key)) userScroll() })

// [F10] Strong ease-out (quint): fast start so motion feels responsive, soft landing.
// Matches the CSS --ease-out curve below: cubic-bezier(0.23, 1, 0.32, 1). The weaker
// built-in/cubic curves feel sluggish at the start of short UI motion.
function easeOut(t: number): number {
	return 1 - (1 - t) ** 5
}

// [F4][F5] Run a layout-changing update and keep a bottom-anchored reader at the bottom.
// Measure BEFORE the change, because afterwards the page is taller and the gap is wrong.
// Scroll only when the reader was near the bottom; otherwise do nothing, which
// naturally keeps whatever they were looking at in place (content grows below them).
// [F6] Preserve the exact gap: a reader 20px above the bottom stays 20px above it,
// instead of snapping to 0. Browsers clamp scrollTop, so no bounds math is needed.
// [F10] Motion modes: 'glide' eases toward the final bottom (new blocks);
// 'jump' goes there instantly (streamed lines: a glide over one line looked janky);
// [F12] 'track' re-pins the gap every frame while a card's height animates, because the
// final height isn't known up front: the page grows or shrinks frame by frame.
// [F15] `force` follows even when scrolled away, landing at the very bottom (gap 0):
// sending a message means the reader wants to see it and the reply.
function keepBottom(change: () => void, mode: 'glide' | 'jump' | 'track' = 'glide', force = false): void {
	const root = document.querySelector('main')!
	// [F10] Mid-glide the reader is still above their destination; keep following its target
	// instead of measuring, or a fast stream would outrun the 50px zone and stop the follow.
	let gap = root.scrollHeight - root.scrollTop - root.clientHeight
	if (glide.frame) gap = glide.gap
	if (force) gap = 0
	change()
	if (gap >= 50) return
	flush() // Solid 2 batches DOM updates to a microtask; apply them so scrollHeight is current.
	stopGlide()
	glide.gap = gap
	glide.forced = force
	const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
	if (mode === 'jump' || reduced) {
		root.scrollTop = root.scrollHeight - root.clientHeight - gap
		return
	}
	const from = root.scrollTop
	const target = root.scrollHeight - root.clientHeight - gap
	const started = performance.now()
	function step(now: number): void {
		let duration = ENTER_MS
		if (mode === 'track') duration = TOGGLE_MS
		const t = Math.min(1, (now - started) / (duration * speed()))
		if (mode === 'track') root.scrollTop = root.scrollHeight - root.clientHeight - gap
		else root.scrollTop = from + ((force ? root.scrollHeight - root.clientHeight : target) - from) * easeOut(t)
		if (t === 1 && force) root.scrollTop = root.scrollHeight - root.clientHeight
		glide.frame = t < 1 ? requestAnimationFrame(step) : 0
	}
	glide.frame = requestAnimationFrame(step)
}

function BlockCard(props: { block: Block }) {
	// [F1] Local state lives in the row. It survives only because the row is keyed by ID.
	const [open, setOpen] = createSignal(false)
	let el: HTMLElement | undefined
	// [F2][F3] Open, apply the DOM update now (Solid 2 batches to a microtask), then center.
	function focus(): void {
		setOpen(true)
		flush()
		el?.scrollIntoView({ block: 'center' })
	}
	// [F3] One-shot check at mount. Deliberately NOT an effect on hash(): an effect re-ran on
	// every data update and yanked the reader back to the card after they had scrolled away.
	// Guard on a real ID: a live block's empty ID equals the empty hash of plain /demo/,
	// which used to open and center every new live block and break the bottom follow.
	onSettled(() => {
		if (props.block.id && location.hash.slice(1) === props.block.id) requestAnimationFrame(focus)
	})
	// [F2] In-page link click.
	function onLinkClick(event: MouseEvent): void {
		// Let Cmd/Ctrl/Shift/middle-click open a new tab or window normally.
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
		event.preventDefault() // Skip the native jump, which aligns the card to the viewport top.
		history.pushState(null, '', `#${props.block.id}`)
		setHash(props.block.id)
		focus()
	}
	// [F11] Clicking anywhere on the card toggles it. The header button's clicks (including
	// keyboard Enter/Space) bubble here too, so it needs no handler of its own. Skip links,
	// and skip clicks that end a text selection so dragging to copy doesn't toggle.
	function onCardClick(event: MouseEvent): void {
		if ((event.target as Element).closest('a')) return
		if (!getSelection()?.isCollapsed) return
		keepBottom(() => setOpen(!open()), 'track')
	}
	return <article ref={(node) => { el = node }} id={props.block.id || undefined} class={[props.block.kind, props.block.id && hash() === props.block.id ? 'target' : '']} style={{ cursor: 'pointer' }} onClick={onCardClick}>
		<header>
			<button type="button" aria-expanded={open() ? 'true' : 'false'}>
				<span>{open() ? '▾' : '▸'} {props.block.kind}</span>
				<span class="state">{open() ? 'Open' : 'Closed'}</span>
			</button>
			<Show when={props.block.id} fallback={<span class="live">live…</span>}>
				<a href={`#${props.block.id}`} onClick={onLinkClick}>{props.block.id}</a>
			</Show>
		</header>
		<div class="stream">{props.block.text ?? 'streamed line\n'.repeat(props.block.lines).trimEnd()}</div>
		{/* [F12] Contents stay mounted so closing can animate too; the grid row animates 0fr <-> 1fr.
		    inert keeps hidden contents out of tab order and the accessibility tree. */}
		<div class={['body', open() ? 'open' : '']} inert={!open()}>
			<div class="contents"><p>This card stays open while new blocks arrive.<br />Data updates received: {props.block.updates}</p></div>
		</div>
	</article>
}

// [F13] Bottom composer like the real Hal: Enter sends, Shift+Enter adds a newline.
// Plain uncontrolled textarea: we only read its value on send.
// [F14] Terminal-style prompt: status line above, help line below, terminal colors.
type Status = { label: string; tone: 'idle' | 'busy' | 'error' }
function Composer(props: { onSend: (text: string) => void; status: Status }) {
	let input: HTMLTextAreaElement | undefined
	const [empty, setEmpty] = createSignal(true)
	function send(): void {
		const text = input!.value.trim()
		if (!text) return
		props.onSend(text)
		input!.value = ''
		setEmpty(true)
		input!.focus()
	}
	function onKeyDown(event: KeyboardEvent): void {
		// isComposing: don't send while an IME is mid-composition (e.g. Japanese input).
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
		event.preventDefault()
		send()
	}
	return <form class="composer" onSubmit={(event) => { event.preventDefault(); send() }}>
		{/* aria-live: screen readers announce status changes (busy, reconnecting) politely. */}
		<div class={['status', props.status.tone]} aria-live="polite">
			<span class="dot" aria-hidden="true">●</span> {props.status.label}
		</div>
		<div class="row">
			<textarea ref={(node) => { input = node }} rows={1} aria-label="Message" onKeyDown={onKeyDown} onInput={(event) => setEmpty(!event.currentTarget.value.trim())} />
			<button type="submit" disabled={empty()}>SEND <span aria-hidden="true">⏎</span></button>
		</div>
		<div class="help"><b>enter</b> send <b>shift+enter</b> newline <b>s</b> step demo</div>
	</form>
}

function Demo() {
	const [blocks, setBlocks] = createSignal<Block[]>([
		{ id: '000001-vw7', kind: 'assistant', updates: 0, lines: 2 },
		{ id: '000002-q4k', kind: 'thinking', updates: 0, lines: 2 },
		{ id: '000003-pku', kind: 'tool', updates: 0, lines: 2 },
	])
	// [F8] Which row identity to use. Compare both: open the live block, wait for it to save.
	// Keyed-by-ID remounts a row when its ID arrives (4th line): it closes AND replays the
	// [F10] fade-in, which looks like a flash to black. By-position avoids both, so it's the default.
	const [byIndex, setByIndex] = createSignal(true)
	// [F14] Simulated connection loss: ticks pause (no data arrives) and the status says so.
	const [offline, setOffline] = createSignal(false)
	// [F14] Status derived from state, like the terminal: the live block's kind names the activity.
	function status(): Status {
		if (offline()) return { label: 'Reconnecting…', tone: 'error' }
		const live = blocks().find((block) => !block.id)
		if (!live) return { label: 'Idle', tone: 'idle' }
		if (live.kind === 'thinking') return { label: 'Thinking…', tone: 'busy' }
		if (live.kind === 'tool') return { label: 'Running bash…', tone: 'busy' }
		return { label: 'Writing…', tone: 'busy' }
	}
	onSettled(() => {
		// [F4][F7] Every change goes through keepBottom, so bottom readers follow and others stay put.
		function tick(): void {
			if (offline()) {
				timer = window.setTimeout(tick, TICK_MS * speed())
				return
			}
			// [F10] No live block means this tick appends a new block (glide); otherwise it only adds a streamed line (jump).
			// The live block is searched, not assumed last: [F13] user messages may land after it.
			const appending = !blocks().some((block) => !block.id)
			keepBottom(() => {
				setBlocks((previous) => {
					// [F1] Simulate full server snapshots: even unchanged blocks get NEW objects.
					const next: Block[] = []
					for (const block of previous) next.push({ ...block, updates: block.updates + 1 })
					const live = next.find((block) => !block.id)
					if (live) {
						// [F7] The live block streams one more line; [F8] then it is saved and gets its ID.
						live.lines++
						if (live.lines >= LINES_BEFORE_SAVE) live.id = `${String(next.indexOf(live) + 1).padStart(6, '0')}-pku`
						return next
					}
					next.push({ id: '', kind: kinds[next.length % kinds.length]!, updates: 0, lines: 1 })
					return next
				})
			}, appending ? 'glide' : 'jump')
			// setTimeout (not setInterval) so toggling slow motion takes effect on the next tick.
			timer = window.setTimeout(tick, TICK_MS * speed())
		}
		let timer = window.setTimeout(tick, TICK_MS * speed())
		// Debug stepping (demo only): 's' runs the next tick now and restarts the timer.
		// Ignored while typing in the composer, where 's' is just a letter.
		function onKey(event: KeyboardEvent): void {
			if (event.key !== 's' || event.metaKey || event.ctrlKey || event.altKey) return
			if ((event.target as Element).closest('textarea, input')) return
			window.clearTimeout(timer)
			tick()
		}
		window.addEventListener('keydown', onKey)
		return () => {
			window.clearTimeout(timer)
			window.removeEventListener('keydown', onKey)
		}
	})
	return <>
		<style>{`
			@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&display=swap');
			* { box-sizing: border-box; }
			/* Animation rules (after Emil Kowalski's skills): one custom strong ease-out for
			   everything entering or responding to the user; never ease-in for UI; exits faster
			   than enters; animate opacity/transform where possible; reduced motion keeps fades
			   but drops movement. */
			/* [F14] Terminal palette, resolved from colors.ason via the terminal colors module. */
			:root {
				--ease-out: cubic-bezier(0.23, 1, 0.32, 1);
				--bg: #0c0f11; --fg: #d9e2e6; --muted: #8c8c8c;
				--user-bg: #04313c; --user-fg: #67d5f5; --user-edge: #6fb6e8;
				--assistant-bg: #000000; --assistant-fg: #ffa156; --assistant-edge: #72cbc3;
				--thinking-bg: #000000; --thinking-fg: #97a7b7; --thinking-edge: #b39ddb;
				--tool-bg: #2a1b2e; --tool-fg: #e89cf9; --tool-edge: #e7b36a;
				--input-bg: #04313c; --cursor: #67d5f5;
				--status-hi: #d9dfe5; --warn: #e6c46b; --error: #ef8a80;
			}
			* { box-sizing: border-box; }
			/* One typeface and one size everywhere; hierarchy comes from weight and color only. */
			body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 'IBM Plex Mono', ui-monospace, Menlo, monospace; }
			.demo-shell { height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
			.demo-title { flex: none; padding: 8px 16px; background: var(--bg); }
			.demo-title h1 { margin: 0 0 4px; }
			.demo-tabs { display: flex; gap: 1ch; overflow-x: auto; white-space: nowrap; color: var(--muted); }
			.demo-tabs span { flex: none; width: 4ch; text-align: center; }
			.demo-tabs .active { color: var(--user-fg); font-weight: 600; }
			main { flex: 1; min-height: 0; width: 100%; margin: 0; padding: 16px; overflow-y: auto; overscroll-behavior: contain; scrollbar-color: var(--assistant-fg) var(--bg); }
			.demo-shell > .composer { flex: none; position: static; width: 100%; margin: 0; padding: 8px 16px max(10px, env(safe-area-inset-bottom)); }
			.demo-shell > .composer > * { width: 100%; }
			h1 { font-size: inherit; font-weight: 600; margin-bottom: 4px; }
			p { color: var(--muted); }
			article { margin: 10px 0; background: var(--assistant-bg); color: var(--assistant-fg); border-left: 3px solid var(--assistant-edge); }
			article.thinking { background: var(--thinking-bg); color: var(--thinking-fg); border-left-color: var(--thinking-edge); }
			article.tool { background: var(--tool-bg); color: var(--tool-fg); border-left-color: var(--tool-edge); }
			article.user { background: var(--user-bg); color: var(--user-fg); border-left-color: var(--user-edge); }
			/* [F9] Target highlight. */
			article.target { outline: 1px solid var(--status-hi); outline-offset: 2px; }
			header { display: flex; align-items: center; }
			header button { flex: 1; display: flex; justify-content: space-between; gap: 12px; padding: 13px; border: 0; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; }
			header a { padding: 13px; color: var(--muted); }
			header a:hover { color: var(--status-hi); }
			header button:focus-visible, header a:focus-visible { outline: 1px solid var(--status-hi); outline-offset: -1px; }
			.state { color: var(--muted); }
			/* [F14] Terminal-style composer: status line, input block, help line; pinned to the bottom. */
			.composer { position: sticky; bottom: 0; margin-top: 24px; padding: 0 16px calc(12px + env(safe-area-inset-bottom)); background: var(--bg); }
			.composer > * { width: min(100%, 740px); margin: 0 auto; }
			.status { padding: 6px 0; color: var(--muted); }
			.status .dot { color: var(--muted); }
			.status.busy, .status.busy .dot { color: var(--status-hi); }
			.status.busy .dot { animation: pulse 1s steps(2) infinite; }
			.status.warn, .status.warn .dot { color: var(--warn); }
			@keyframes pulse { 50% { opacity: 0.3; } }
			@media (prefers-reduced-motion: reduce) { .status .dot { animation: none !important; } }
			/* Equal height: flex row stretches both children; they share padding, border, font, and line-height. */
			.row { display: flex; align-items: stretch; background: var(--input-bg); border-left: 3px solid var(--user-edge); }
			textarea { flex: 1; min-width: 0; field-sizing: content; max-height: 40vh; margin: 0; padding: 10px 13px; border: 0; background: transparent; color: var(--user-fg); caret-color: var(--cursor); font: inherit; resize: none; outline: none; }
			/* Retro-futuristic Send: outlined terminal key that lights up on hover, inverts when pressed. */
			.row button { margin: 0; padding: 10px 16px; border: 0; border-left: 1px solid color-mix(in oklab, var(--user-edge) 45%, transparent); background: transparent; color: var(--status-hi); font: inherit; font-weight: 600; letter-spacing: 0.12em; cursor: pointer; transition: background-color 120ms var(--ease-out), color 120ms var(--ease-out); }
			.row button:hover:not(:disabled) { background: color-mix(in oklab, var(--status-hi) 14%, transparent); text-shadow: 0 0 8px color-mix(in oklab, var(--status-hi) 60%, transparent); }
			.row button:active:not(:disabled) { background: var(--status-hi); color: var(--bg); text-shadow: none; }
			.row button:disabled { color: var(--muted); cursor: default; }
			.row button:focus-visible { outline: 1px solid var(--status-hi); outline-offset: -3px; }
			.row:focus-within { border-left-color: var(--cursor); }
			.help { padding: 6px 0 0; color: var(--muted); }
			.help b { color: var(--fg); font-weight: 600; }
			/* [F9] Target highlight. */
			article.target { outline: 1px solid var(--status-hi); outline-offset: 2px; }
			header { display: flex; align-items: center; }
			header button { flex: 1; display: flex; justify-content: space-between; gap: 12px; padding: 13px; border: 0; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; }
			header a { padding: 13px; color: var(--muted); }
			header a:hover { color: var(--status-hi); }
			header button:focus-visible, header a:focus-visible { outline: 1px solid var(--status-hi); outline-offset: -3px; }
			/* [F13] Composer. Sticky (not fixed) at the bottom: it stays in flow, so it never covers
			   the last card and keepBottom's scrollHeight math needs no extra padding. */
			.composer { position: sticky; bottom: 0; width: min(100% - 32px, 740px); margin: 0 auto; padding: 8px 0 max(10px, env(safe-area-inset-bottom)); background: var(--bg); }
			.state { color: var(--muted); }
			/* [F12] Height animation: a one-row grid animates 0fr <-> 1fr, i.e. 0 <-> content height,
			   without measuring. min-height: 0 lets the inner box shrink below its content.
			   Padding sits on an inner element so the collapsed row is truly 0px tall.
			   This is a layout animation (not transform/opacity): fine for small cards, watch it on
			   very tall ones. A transition (not keyframes) so rapid re-clicks retarget smoothly.
			   Closing is faster than opening: the user already decided, don't make them wait. */
			.body { display: grid; grid-template-rows: 0fr; transition: grid-template-rows calc(var(--toggle-ms, ${TOGGLE_MS}ms) * 0.7) var(--ease-out); }
			.body.open { grid-template-rows: 1fr; transition-duration: var(--toggle-ms, ${TOGGLE_MS}ms); }
			.body > .contents { min-height: 0; overflow: hidden; }
			.contents > p { margin: 0; padding: 0 13px 13px; }
			@media (prefers-reduced-motion: reduce) { .body, .body.open { transition: none; } }
			.stream { padding: 0 13px 13px; white-space: pre-wrap; }
			header .live { padding: 13px; color: var(--status-hi); }
			/* [F16] Dedicated Hal cursor line, always after the final card. Orange like an
			   assistant response; grey while thinking. No caret styling on the textarea. */
			.hal-cursor { min-height: 40px; padding: 7px 0 12px; color: var(--assistant-fg); }
			.hal-cursor.thinking { color: var(--thinking-fg); }
			.hal-cursor span { display: block; width: 1ch; height: 1lh; background: currentColor; animation: hal-blink 1s steps(1, end) infinite; }
			@keyframes hal-blink { 50% { opacity: 0; } }
			@media (prefers-reduced-motion: reduce) { .hal-cursor span { animation: none; } }
			label { display: block; margin-bottom: 16px; color: var(--muted); cursor: pointer; }
		`}</style>
		<div class="demo-shell" style={{ '--fade-ms': `${FADE_MS * speed()}ms`, '--toggle-ms': `${TOGGLE_MS * speed()}ms` }}>
			<div class="demo-title">
				<h1>Block identity experiment</h1>
				<div class="demo-tabs">Tabs: <span class="active">[1]</span><span>2</span><span>3</span><span>4</span></div>
			</div>
			<main>
				<p>Every second: clone every block and update its data. A new block streams without an ID, grows a line per second, then gets its ID. Open any card; it should stay open.</p>
				<label><input type="checkbox" checked={byIndex()} onChange={(event) => setByIndex(event.currentTarget.checked)} /> Key rows by index instead of ID [F8]</label>
				<label><input type="checkbox" checked={slow()} onChange={(event) => setSlow(event.currentTarget.checked)} /> Slow motion (5×): ticks, glide, and fade</label>
				<label><input type="checkbox" checked={offline()} onChange={(event) => setOffline(event.currentTarget.checked)} /> Simulate lost connection [F14]</label>
				{/* [F8] Two lists because keyed={false} and keyed={fn} are different <For> modes. */}
				<Show when={byIndex()} fallback={
					<For each={blocks()} keyed={(block) => block.id}>
						{(block) => <BlockCard block={block()} />}
					</For>
				}>
					<For each={blocks()} keyed={false}>
						{(block) => <BlockCard block={block()} />}
					</For>
				</Show>
				<div class={['hal-cursor', blocks().some((block) => !block.id && block.kind === 'thinking') ? 'thinking' : '']} aria-label="Hal cursor"><span aria-hidden="true" /></div>
			</main>
			<Composer status={status()} onSend={(text) => keepBottom(() => {
				// [F13] Always append: index keying [F8] relies on the list being append-only.
				setBlocks((previous) => [...previous, { id: `${String(previous.length + 1).padStart(6, '0')}-usr`, kind: 'user', updates: 0, lines: 1, text }])
			}, 'glide', true)} />
		</div>
	</>
}

render(() => <Demo />, document.querySelector('#app')!)
