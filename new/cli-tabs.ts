// Tab state and management.

import type { Block } from './cli-blocks.ts'

export interface Tab {
	id: number
	blocks: Block[]
}

let tabs: Tab[] = [{ id: 1, blocks: [] }]
let activeIdx = 0
let nextId = 2

export function all(): Tab[] { return tabs }
export function active(): Tab { return tabs[activeIdx] }
export function activeIndex(): number { return activeIdx }
export function count(): number { return tabs.length }

/** Create a new tab at the end. Returns the new tab. */
export function create(): Tab {
	const tab: Tab = { id: nextId++, blocks: [] }
	tabs.push(tab)
	activeIdx = tabs.length - 1
	return tab
}

/** Fork: insert a new tab right after the current one. Returns the new tab. */
export function fork(): Tab {
	const tab: Tab = { id: nextId++, blocks: [] }
	tabs.splice(activeIdx + 1, 0, tab)
	activeIdx = activeIdx + 1
	return tab
}

/** Close current tab. Returns false if it was the last tab (caller should quit). */
export function closeCurrent(): boolean {
	if (tabs.length <= 1) return false
	tabs.splice(activeIdx, 1)
	if (activeIdx >= tabs.length) activeIdx = tabs.length - 1
	return true
}

export function next(): void { activeIdx = (activeIdx + 1) % tabs.length }
export function prev(): void { activeIdx = (activeIdx - 1 + tabs.length) % tabs.length }
export function switchTo(idx: number): void { activeIdx = Math.max(0, Math.min(idx, tabs.length - 1)) }
