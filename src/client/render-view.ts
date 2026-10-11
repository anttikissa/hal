import { frame, type View } from './frame.ts'
import { render } from './render.ts'
import { terminal } from './terminal.ts'

function draw(force = false, trigger?: string): void {
	let st = render.state
	if (terminal.state.external || !st.out || (st.parked && !force)) return
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
		frame.state.rows = new WeakMap()
		frame.state.peaks.clear()
		frame.state.history = undefined
		st.past = undefined
	}
	let session = st.view.transcript?.meta.id
	let past = frame.layout(st.view, cols, performance.now() + render.sliceMs, true, rows)
	if (!past) {
		render.later()
		past = st.past && st.past.session === session ? st.past.past : frame.layout(render.tail(st.view, cols, rows), cols, Infinity, false, rows)!
	}
	st.past = { session, past }
	let next = frame.build(st.view, cols, rows, st.fullscreen, past)
	if (st.view.modal && next.modalScroll !== undefined) st.view.modal.scroll = next.modalScroll
	st.view.prompt.scroll = next.promptScroll
	let out = st.out
	let pending = ''
	for (let p of render.paintParts(next, rows, force, trigger)) {
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
	for (let n = 0; at > 0 && n < rows; ) n += frame.itemRows(t.items[--at]!, cols, t.meta.id).length + 1
	return { ...view, transcript: { ...t, items: t.items.slice(at) } }
}

function later(): void {
	let st = render.state
	if (st.slicing) return
	st.slicing = setTimeout(() => {
		st.slicing = null
		if (!st.out) return
		if (frame.layout(st.view, st.out.size().cols, performance.now() + render.sliceMs, true, st.out.size().rows)) render.request()
		else render.later()
	}, 0)
}

function request(): void {
	let st = render.state
	if (st.timer) {
		st.dirty = true
		return
	}
	queueMicrotask(() => ((st.dirty = false), render.draw()))
	st.timer = setTimeout(() => {
		st.timer = null
		if (!st.dirty) return
		st.dirty = false
		render.request()
	}, render.frameMs)
}

function show(view: View): void {
	render.state.view = view
	render.request()
}

export const renderView = { draw, tail, later, request, show }
