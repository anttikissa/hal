// Shared fixtures for the frame tests: model display names reset around
// each test, a view of items, and helpers that read frames back as text.

import { afterEach, beforeEach } from 'bun:test'
import { strings } from '../common/strings.ts'
import { titles } from '../common/titles.ts'
import type { Shown as Item, Transcript } from '../common/transcript.ts'
import type { Frame, View } from './frame.ts'

// Model names set in one test stay out of the next.
export function useNames(): void {
	let originalNames: Record<string, string>
	beforeEach(() => {
		originalNames = titles.names
		titles.names = { 'anthropic/claude-opus-5-5': 'Opus 5.5' }
	})
	afterEach(() => {
		titles.names = originalNames
	})
}

// Visible text only: escape sequences removed.
export function strip(s: string): string {
	let out = ''
	strings.walk(s, 0, (i, _w, len) => {
		out += s.slice(i, i + len)
	})
	return out
}

export function view(items: Item[], text = '', cursor = text.length): View {
	let transcript: Transcript = {
		meta: { id: 's', cwd: '/', model: 'm', createdAt: '' },
		state: { type: 'idle' },
		inbox: [],
		items: items.map((item, i) => ({ ...item, key: `~${i}` })),
	}
	return { transcript, prompt: { text, cursor } }
}

// The frame without escape sequences and trailing blanks.
export function plain(lines: string[]): string[] {
	return lines.map((l) => strip(l).trim())
}

// The prompt box in a frame: the indices of its two rules and the
// plain rows between them.
export function boxOf(f: Frame): { top: number; bottom: number; rows: string[] } {
	let lines = plain(f.lines)
	let rules = lines.flatMap((l, i) => (/^([↑↓]\d+ )?─/.test(l) ? [i] : []))
	let [top, bottom] = rules.slice(-2) as [number, number]
	return { top, bottom, rows: lines.slice(top + 1, bottom) }
}

// OSC 8 targets in `lines`, in order.
export function targets(lines: string[]): string[] {
	return lines.flatMap((l) => [...l.matchAll(/\x1b\]8;;([^\x07]+)\x07/g)].map((m) => m[1]!))
}
