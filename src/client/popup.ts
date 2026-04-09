// Small popup layer for transient UI that should draw over the normal frame.
// Kept intentionally narrow: one active popup, list-style rows, optional input.

import { lineEditor } from '../cli/line-editor.ts'
import { models } from '../models.ts'
import { clipVisual, visLen } from '../utils/strings.ts'
import type { KeyEvent } from '../cli/keys.ts'

interface PopupItem {
	value: string
	label: string
}

interface Overlay {
	x: number
	y: number
	lines: string[]
	cursor: { row: number; col: number } | null
}

const editor = lineEditor.create()

const state = {
	active: false,
	kind: null as 'model' | 'confirm' | null,
	title: '',
	tone: 'neutral' as 'neutral' | 'warning',
	body: [] as string[],
	items: [] as PopupItem[],
	selectedIndex: 0,
	onChoose: null as ((value: string) => void) | null,
}

const MODEL_CHOICES = models.listModelChoices()
const YELLOW = '\x1b[33m'
const GRAY = '\x1b[38;5;245m'
const RESET = '\x1b[0m'

function close(): void {
	state.active = false
	state.kind = null
	state.title = ''
	state.body = []
	state.items = []
	state.selectedIndex = 0
	state.onChoose = null
	editor.clear()
}

function refreshModelItems(): void {
	const query = editor.text().trim().toLowerCase()
	const matches = MODEL_CHOICES.filter((item) => item.search.includes(query))
	state.items = matches.map((item) => ({ value: item.value, label: item.label }))
	if (state.selectedIndex >= state.items.length) state.selectedIndex = Math.max(0, state.items.length - 1)
}

function openModelPicker(onChoose: (value: string) => void): void {
	close()
	state.active = true
	state.kind = 'model'
	state.title = 'Pick a model'
	state.tone = 'neutral'
	state.onChoose = onChoose
	refreshModelItems()
}

function openConfirm(title: string, body: string[], choices: string[], onChoose: (value: string) => void): void {
	close()
	state.active = true
	state.kind = 'confirm'
	state.title = title
	state.tone = 'warning'
	state.body = body
	state.items = choices.map((choice) => ({ value: choice, label: choice }))
	state.onChoose = onChoose
}

function cycle(dir: 1 | -1): void {
	if (state.items.length === 0) return
	state.selectedIndex = (state.selectedIndex + dir + state.items.length) % state.items.length
}

function chooseSelected(): void {
	const item = state.items[state.selectedIndex]
	if (!item || !state.onChoose) return
	const onChoose = state.onChoose
	close()
	onChoose(item.value)
}

function handleKey(k: KeyEvent): boolean {
	if (!state.active) return false
	if (k.key === 'escape') {
		close()
		return true
	}
	if (k.key === 'enter' && !k.shift) {
		chooseSelected()
		return true
	}
	if (k.key === 'tab' && !k.ctrl && !k.alt && !k.cmd) {
		cycle(k.shift ? -1 : 1)
		return true
	}
	if (k.key === 'down') {
		cycle(1)
		return true
	}
	if (k.key === 'up') {
		cycle(-1)
		return true
	}
	if (state.kind === 'model' && editor.handleKey(k)) {
		refreshModelItems()
		return true
	}
	return false
}

function toneColor(): string {
	return state.tone === 'warning' ? YELLOW : GRAY
}

function rowText(item: PopupItem, active: boolean): string {
	return active ? `[${item.label}]` : ` ${item.label}`
}

function pad(text: string, width: number): string {
	return text + ' '.repeat(Math.max(0, width - visLen(text)))
}

function buildOverlay(cols: number, rows: number): Overlay | null {
	if (!state.active || cols < 12 || rows < 6) return null
	const content: string[] = []
	let inputCursor: { row: number; col: number } | null = null
	if (state.kind === 'model') {
		const built = editor.buildLine()
		content.push(`> ${built.line}`)
		content.push('')
		inputCursor = { row: 1, col: 4 + built.cursor }
	}
	for (const line of state.body) content.push(line)
	if (state.body.length > 0 && state.items.length > 0) content.push('')
	for (let i = 0; i < state.items.length; i++) content.push(rowText(state.items[i]!, i === state.selectedIndex))
	if (content.length === 0) content.push('')
	const rawWidth = Math.max(visLen(state.title) + 2, ...content.map((line) => visLen(line)))
	const innerWidth = Math.max(18, Math.min(cols - 4, rawWidth))
	const title = clipVisual(` ${state.title} `, Math.max(0, innerWidth - 2))
	const titleWidth = visLen(title)
	const top = `┌${title}${'─'.repeat(Math.max(0, innerWidth - titleWidth))}┐`
	const lines = [top]
	for (const line of content) lines.push(`│${pad(clipVisual(line, innerWidth), innerWidth)}│`)
	lines.push(`└${'─'.repeat(innerWidth)}┘`)
	const x = Math.max(0, Math.floor((cols - (innerWidth + 2)) / 2))
	const y = Math.max(0, Math.floor((rows - lines.length) / 2))
	const color = toneColor()
	const colored = lines.map((line, index) => {
		if (index === 0 || index === lines.length - 1) return `${color}${line}${RESET}`
		return `${color}${line[0]}${RESET}${line.slice(1, -1)}${color}${line[line.length - 1]}${RESET}`
	})
	return {
		x,
		y,
		lines: colored,
		cursor: inputCursor ? { row: y + inputCursor.row, col: x + inputCursor.col } : null,
	}
}

export const popup = { state, close, openModelPicker, openConfirm, handleKey, buildOverlay }
