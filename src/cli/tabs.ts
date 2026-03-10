// Tab state and management.

import type { Block } from './blocks.ts'

export interface Tab {
	id: number
	blocks: Block[]
}

let tabList: Tab[] = [{ id: 1, blocks: [] }]
let activeIdx = 0
let nextId = 2

export function all(): Tab[] { return tabList }
export function active(): Tab { return tabList[activeIdx] }
export function activeIndex(): number { return activeIdx }
export function count(): number { return tabList.length }

/** Create a new tab at the end. Returns the new tab. */
export function create(): Tab {
	const tab: Tab = { id: nextId++, blocks: [] }
	tabList.push(tab)
	activeIdx = tabList.length - 1
	return tab
}

/** Fork: insert a new tab right after the current one. Returns the new tab. */
export function fork(): Tab {
	const tab: Tab = { id: nextId++, blocks: [] }
	tabList.splice(activeIdx + 1, 0, tab)
	activeIdx = activeIdx + 1
	return tab
}

/** Close current tab. Returns false if it was the last tab (caller should quit). */
export function closeCurrent(): boolean {
	if (tabList.length <= 1) return false
	tabList.splice(activeIdx, 1)
	if (activeIdx >= tabList.length) activeIdx = tabList.length - 1
	return true
}

export function next(): void { activeIdx = (activeIdx + 1) % tabList.length }
export function prev(): void { activeIdx = (activeIdx - 1 + tabList.length) % tabList.length }
export function switchTo(idx: number): void { activeIdx = Math.max(0, Math.min(idx, tabList.length - 1)) }

export const tabs = {
	all,
	active,
	activeIndex,
	count,
	create,
	fork,
	closeCurrent,
	next,
	prev,
	switchTo,
}
