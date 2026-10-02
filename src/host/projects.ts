// Project colors (task 22): which project each tab's cwd belongs to and
// the color index (colors.project) the tab bar and status row show for
// it, only while open tabs span two or more projects.

import { existsSync } from 'fs'
import { basename, dirname } from 'path'
import { colors } from '../common/colors.ts'
import type { Tab } from '../common/protocol.ts'

// The nearest ancestor of cwd holding .git, else cwd itself.
function root(cwd: string): string {
	let cached = projects.state.roots.get(cwd)
	if (cached) return cached
	let dir = cwd.replace(/(.)\/+$/, '$1')
	let found = dir
	for (let d = dir; ; d = dirname(d)) {
		if (existsSync(`${d}/.git`)) {
			found = d
			break
		}
		if (dirname(d) === d) break
	}
	projects.state.roots.set(cwd, found)
	return found
}

// A project's preferred color: FNV-1a of its name, so ~/.hal and ~/hal
// prefer the same color on every machine.
function preferred(root: string, size: number): number {
	let h = 0x811c9dc5
	for (let c of basename(root).replace(/^\.+/, '').toLowerCase()) h = Math.imul(h ^ c.codePointAt(0)!, 16777619) >>> 0
	return h % size
}

// The free color farthest (around the palette) from those in use, ties
// nearest the preference; the preference when none is free.
function pick(want: number, used: Set<number>, size: number): number {
	if (!used.has(want)) return want
	let around = (a: number, b: number) => Math.min((a - b + size) % size, (b - a + size) % size)
	let best = want
	let score = [-1, 0]
	for (let i = 0; i < size; i++) {
		if (used.has(i)) continue
		let s = [Math.min(...[...used].map((u) => around(i, u))), -around(i, want)]
		if (s[0]! < score[0]! || (s[0] === score[0] && s[1]! <= score[1]!)) continue
		best = i
		score = s
	}
	return best
}

// Sets tab.color on every tab when they span two or more projects. A
// project keeps its color while it has open tabs.
function paint(list: Tab[]): void {
	let size = Object.keys(colors.project()).length
	let roots = list.map((t) => root(t.cwd))
	let open = new Set(roots)
	let assigned = projects.state.assigned
	for (let r of assigned.keys()) if (!open.has(r)) assigned.delete(r)
	for (let r of open) if (!assigned.has(r)) assigned.set(r, pick(preferred(r, size), new Set(assigned.values()), size))
	if (open.size < 2) return
	list.forEach((t, i) => (t.color = assigned.get(roots[i]!)!))
}

export const projects = {
	state: { roots: new Map<string, string>(), assigned: new Map<string, number>() },
	root,
	preferred,
	pick,
	paint,
}
