// Small popup layer for transient UI that should draw over the normal frame.
// Kept intentionally narrow: one active popup, list-style rows, optional input.

import { lineEditor } from '../cli/line-editor.ts'
import { colors } from '../cli/colors.ts'
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
	preferredInnerWidth: null as number | null,
}

const MODEL_CHOICES = models.listModelChoices()
const MODEL_PICKER_INNER_WIDTH = 72
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
	state.preferredInnerWidth = null
	editor.clear()
}

function refreshModelItems(): void {
	const query = editor.text().trim().toLowerCase()
	const matches = MODEL_CHOICES.filter((item) => item.search.includes(query))
	state.items = matches.map((item) => ({ value: item.value, label: item.label }))
	if (state.selectedIndex >= state.items.length) state.selectedIndex = Math.max(0, state.items.length - 1)
}

function openModelPicker(onChoose: (value: string) => void, currentModel?: string): void {
	close()
	state.active = true
	state.kind = 'model'
	state.title = 'Pick a model'
	state.tone = 'neutral'
	state.onChoose = onChoose
	state.preferredInnerWidth = MODEL_PICKER_INNER_WIDTH
	refreshModelItems()
	const target = currentModel ? models.resolveModel(currentModel) : ''
	const match = target ? MODEL_CHOICES.findIndex((item) => models.resolveModel(item.value) === target) : -1
	if (match >= 0) state.selectedIndex = match
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

function styleRow(text: string, active: boolean): string {
	if (!active) return text
	return `${colors.popup.current.bg}${colors.popup.current.fg}${text}${RESET}`
}

function buildOverlay(cols: number, rows: number): Overlay | null {
	if (!state.active || cols < 12 || rows < 6) return null
	const content: Array<{ text: string; active: boolean }> = []
	let inputCursor: { row: number; col: number } | null = null
	if (state.kind === 'model') {
		const built = editor.buildLine()
		content.push({ text: `> ${built.line}`, active: false })
		content.push({ text: '', active: false })
		inputCursor = { row: 1, col: 4 + built.cursor }
	}
	for (const line of state.body) content.push({ text: line, active: false })
	if (state.body.length > 0 && state.items.length > 0) content.push({ text: '', active: false })
	for (let i = 0; i < state.items.length; i++) content.push({ text: rowText(state.items[i]!, i === state.selectedIndex), active: i === state.selectedIndex })
	if (content.length === 0) content.push({ text: '', active: false })

	// Keep a safety margin away from the terminal's last column and last row.
	// Touching those edges can trigger wrap-pending weirdness in some terminals.
	const rightSlack = cols > 12 ? 1 : 0
	const bottomSlack = rows > 6 ? 1 : 0
	const rawWidth = Math.max(visLen(state.title) + 2, ...content.map((line) => visLen(line.text)))
	const maxInnerWidth = Math.max(18, cols - rightSlack - 2)
	const innerWidth = Math.max(18, Math.min(maxInnerWidth, state.preferredInnerWidth ?? rawWidth))
	const title = clipVisual(` ${state.title} `, Math.max(0, innerWidth - 2))
	const titleWidth = visLen(title)
	const top = `┌${title}${'─'.repeat(Math.max(0, innerWidth - titleWidth))}┐`
	const lines = [top]
	for (const line of content) {
		const padded = pad(clipVisual(line.text, innerWidth), innerWidth)
		lines.push(`│${styleRow(padded, line.active)}│`)
	}
	lines.push(`└${'─'.repeat(innerWidth)}┘`)
	const totalWidth = innerWidth + 2
	const maxX = Math.max(0, cols - rightSlack - totalWidth)
	const x = Math.max(0, Math.floor(maxX / 2))
	const maxY = Math.max(0, rows - bottomSlack - lines.length)
	const y = Math.max(0, Math.min(Math.floor((rows - lines.length) / 2), maxY))
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
