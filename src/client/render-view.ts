// Builds terminal frames and schedules incremental paints and canonical
// rebuilds.
import { frame, type View } from './frame.ts'
import { frameLayout, type Past } from './frame-layout.ts'
import { render } from './render.ts'
import { terminal } from './terminal.ts'
import { batchOrder } from './batch-order.ts'

function rebuild(view: View): void {
	batchOrder.state.split.clear()
	batchOrder.state.joined = new WeakSet(view.transcript?.items.filter((item) => item.type === 'tool-result'))
	frame.state.rows = new WeakMap()
	frame.state.peaks.clear()
	frameLayout.state.history = undefined
	frameLayout.state.ordered = undefined
}

function draw(force = false, trigger?: string): void {
	let st = render.state
	if (terminal.state.external || terminal.state.suspended || !st.out || (st.parked && !force)) return
	st.parked = false
	let { rows, cols } = st.out.size()
	if (!st.fullscreen && (st.view.tabs?.list.length ?? render.startTabs) > 1) {
		st.fullscreen = force = true
		trigger = 'the first paint with two or more tabs'
	}
	let tab = st.view.tabs?.focused
	if (tab !== undefined) {
		if (st.tab !== undefined && st.tab !== tab) {
			st.fullscreen = force = true
			trigger = 'a tab switch'
		}
		st.tab = tab
	}
	if (force) {
		rebuild(st.view)
		st.past = undefined
	}
	let session = st.view.transcript?.meta.id
	// No paint lays out the whole history at once, not even a forced one
	// (task 7j): until the slices finish, the last rows painted or the
	// history's tail stand in.
	let lay = (): Past => {
		let kept = st.past?.session === session ? st.past : undefined
		let full = frameLayout.layout(st.view, cols, performance.now() + render.sliceMs, true, rows)
		if (full) {
			st.past = { session, past: full, tail: false }
			return full
		}
		render.later()
		st.past = kept ?? {
			session,
			past: frameLayout.layout(render.tail(st.view, cols, rows), cols, Infinity, false, rows)!,
			tail: true,
		}
		return st.past.past
	}
	let wasTail = st.past?.tail === true && st.past.session === session
	let past = lay()
	// The whole history replaces its tail in one canonical repaint; it was
	// just laid out, so it needs no rebuild.
	if (wasTail && !st.past!.tail) {
		force = true
		trigger ??= 'the end of a sliced layout'
	}
	// Full mode never shrinks between forced paints: rows given up turn
	// into padding above the chrome instead of clearing scrollback.
	let next = frame.build(st.view, cols, rows, st.fullscreen, past, st.fullscreen && !force ? st.prev.length : 0)
	if (st.view.modal && next.modalScroll !== undefined) st.view.modal.scroll = next.modalScroll
	st.view.prompt.scroll = next.promptScroll
	let out = st.out
	let pending = ''
	for (let p of render.paintParts(next, rows, force, trigger, () => {
		rebuild(st.view)
		st.past = undefined
		return frame.build(st.view, cols, rows, st.fullscreen, lay())
	})) {
		if (typeof p === 'string') pending += p
		else if (out.defer) {
			if (pending) out.write(pending)
			pending = ''
			out.defer(p)
		} else pending += p()
	}
	if (pending) out.write(pending)
	render.painted(st.view)
}

function tail(view: View, cols: number, rows: number): View {
	let t = view.transcript
	if (!t) return view
	let at = t.items.length
	for (let n = 0; at > 0 && n < rows;) n += frame.itemRows(t.items[--at]!, cols, t.meta.id).length + 1
	return { ...view, transcript: { ...t, items: t.items.slice(at) } }
}

function later(): void {
	let st = render.state
	if (st.slicing) return
	st.slicing = setTimeout(() => {
		st.slicing = null
		if (!st.out) return
		let { cols, rows } = st.out.size()
		if (frameLayout.layout(st.view, cols, performance.now() + render.sliceMs, true, rows)) render.request()
		else render.later()
	}, 0)
}

function show(view: View): void {
	render.state.view = view
	render.request()
}

export const renderView = { draw, tail, later, show }
