// Small popup layer for transient UI that should draw over the normal frame.
// Kept intentionally narrow: one active popup, list-style rows, optional input.

import { lineEditor } from '../cli/line-editor.ts'
import { colors } from '../cli/colors.ts'
import { models } from '../models.ts'
import { clipVisual, hardWrap, visLen } from '../utils/strings.ts'
import type { KeyEvent } from '../cli/keys.ts'

interface PopupItem {
	value: string
	label: string
	kind: 'model' | 'category'
	path?: string
	choice?: ReturnType<typeof models.listModelChoices>[number]
}

interface ModelTreeNode {
	name: string
	path: string
	children: ModelTreeNode[]
	choice?: ReturnType<typeof models.listModelChoices>[number]
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
	tone: 'neutral' as 'neutral' | 'warning' | 'danger',
	body: [] as string[],
	items: [] as PopupItem[],
	selectedIndex: 0,
	onChoose: null as ((value: string) => void) | null,
	preferredInnerWidth: null as number | null,
	openModelCategories: new Set<string>(),
}

const DEFAULT_OPEN_MODEL_CATEGORIES = ['openai', 'openai/gpt', 'anthropic', 'anthropic/fable', 'anthropic/opus']
const MODEL_PICKER_INNER_WIDTH = 72
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
	state.openModelCategories = new Set()
	editor.clear()
}

function resetOpenModelCategories(): void {
	state.openModelCategories = new Set(DEFAULT_OPEN_MODEL_CATEGORIES)
}

function modelCategoryLabel(name: string, depth: number, open: boolean): string {
	return `${'  '.repeat(depth)}${open ? '▾' : '▸'} ${name}`
}

function modelLeafLabel(choice: ReturnType<typeof models.listModelChoices>[number], depth: number): string {
	return `${'  '.repeat(depth)}  ${choice.leafLabel.padEnd(12)} ${choice.display} · ${choice.fullId}`
}

function treeChild(parent: ModelTreeNode, name: string, path: string): ModelTreeNode {
	let child = parent.children.find((node) => node.name === name && !node.choice)
	if (!child) {
		child = { name, path, children: [] }
		parent.children.push(child)
	}
	return child
}

function buildModelTree(choices: ReturnType<typeof models.listModelChoices>): ModelTreeNode {
	const root: ModelTreeNode = { name: '', path: '', children: [] }
	for (const choice of choices) {
		let parent = root
		let path = ''
		for (const part of choice.path) {
			path = path ? `${path}/${part}` : part
			parent = treeChild(parent, part, path)
		}
		parent.children.push({ name: choice.leafLabel, path: `${path}/${choice.value}`, children: [], choice })
	}
	return root
}

function addModelTreeRows(rows: PopupItem[], node: ModelTreeNode, depth: number): void {
	for (const child of node.children) {
		if (child.choice) {
			rows.push({ value: child.choice.value, label: modelLeafLabel(child.choice, depth), kind: 'model', choice: child.choice })
			continue
		}
		const open = state.openModelCategories.has(child.path)
		rows.push({ value: `category:${child.path}`, label: modelCategoryLabel(child.name, depth, open), kind: 'category', path: child.path })
		if (open) addModelTreeRows(rows, child, depth + 1)
	}
}

function refreshModelItems(): void {
	const query = editor.text().trim().toLowerCase()
	const choices = models.listModelChoices()
	if (query) {
		const matches = choices.filter((item) => item.search.includes(query))
		state.items = matches.map((item) => ({ value: item.value, label: item.label, kind: 'model', choice: item }))
	} else {
		const rows: PopupItem[] = []
		addModelTreeRows(rows, buildModelTree(choices), 0)
		state.items = rows
	}
	if (state.selectedIndex >= state.items.length) state.selectedIndex = Math.max(0, state.items.length - 1)
}

function selectModelValue(target: string): void {
	const index = state.items.findIndex((item) => item.kind === 'model' && models.resolveModel(item.value) === target)
	if (index >= 0) state.selectedIndex = index
}

function openModelPicker(onChoose: (value: string) => void, currentModel?: string): void {
	close()
	resetOpenModelCategories()
	state.active = true
	state.kind = 'model'
	state.title = 'Pick a model'
	state.tone = 'neutral'
	state.onChoose = onChoose
	state.preferredInnerWidth = MODEL_PICKER_INNER_WIDTH
	refreshModelItems()
	if (currentModel) selectModelValue(models.resolveModel(currentModel))
}

function openConfirm(title: string, body: string[], choices: string[], onChoose: (value: string) => void, tone: 'warning' | 'danger' = 'warning'): void {
	close()
	state.active = true
	state.kind = 'confirm'
	state.title = title
	state.tone = tone
	state.body = body
	state.items = choices.map((choice) => ({ value: choice, label: choice, kind: 'model' }))
	state.onChoose = onChoose
}

function cycle(dir: 1 | -1): void {
	if (state.items.length === 0) return
	state.selectedIndex = (state.selectedIndex + dir + state.items.length) % state.items.length
}

function setSelectedCategoryOpen(open: boolean): boolean {
	const item = state.items[state.selectedIndex]
	if (!item || item.kind !== 'category' || !item.path) return false
	const wasOpen = state.openModelCategories.has(item.path)
	if (open === wasOpen) return false
	if (open) state.openModelCategories.add(item.path)
	else state.openModelCategories.delete(item.path)
	const selectedPath = item.path
	refreshModelItems()
	const nextIndex = state.items.findIndex((row) => row.kind === 'category' && row.path === selectedPath)
	if (nextIndex >= 0) state.selectedIndex = nextIndex
	return true
}

function chooseSelected(): void {
	const item = state.items[state.selectedIndex]
	if (!item || !state.onChoose) return
	if (item.kind === 'category') {
		if (!setSelectedCategoryOpen(!state.openModelCategories.has(item.path ?? ''))) setSelectedCategoryOpen(true)
		return
	}
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
	if (state.kind === 'model' && k.key === 'right' && setSelectedCategoryOpen(true)) {
		return true
	}
	if (state.kind === 'model' && k.key === 'left' && setSelectedCategoryOpen(false)) {
		return true
	}
	if (state.kind === 'model' && editor.handleKey(k)) {
		refreshModelItems()
		return true
	}
	return false
}

function toneColor(): string {
	if (state.tone === 'danger') return colors.popup.dangerFg || colors.warning.fg
	return state.tone === 'warning' ? colors.popup.warningFg || colors.warning.fg : colors.popup.neutralFg || colors.status.fg
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

interface PopupRow {
	text: string
	active: boolean
}

function wrapRows(rows: PopupRow[], width: number): PopupRow[] {
	const out: PopupRow[] = []
	for (const row of rows) {
		for (const text of hardWrap(row.text, width)) out.push({ text, active: row.active })
	}
	return out
}

function clipBodyRows(bodyRows: PopupRow[], tailRows: PopupRow[], maxRows: number): PopupRow[] {
	if (bodyRows.length + tailRows.length <= maxRows) return [...bodyRows, ...tailRows]
	const availableBodyRows = maxRows - tailRows.length
	if (availableBodyRows <= 0) return tailRows.slice(0, maxRows)
	if (availableBodyRows === 1) return [{ text: `[+ ${bodyRows.length} lines]`, active: false }, ...tailRows]

	const keepRows = availableBodyRows - 1
	const headRows = Math.max(1, Math.ceil(keepRows / 2))
	const bottomRows = Math.max(0, keepRows - headRows)
	const hiddenRows = bodyRows.length - headRows - bottomRows
	if (hiddenRows <= 0) return [...bodyRows, ...tailRows]

	return [
		...bodyRows.slice(0, headRows),
		{ text: `[+ ${hiddenRows} lines]`, active: false },
		...bodyRows.slice(bodyRows.length - bottomRows),
		...tailRows,
	]
}

function buildOverlay(cols: number, rows: number): Overlay | null {
	if (!state.active || cols < 12 || rows < 6) return null
	const bodyContent: PopupRow[] = []
	const tailContent: PopupRow[] = []
	let inputCursor: { row: number; col: number } | null = null
	if (state.kind === 'model') {
		const built = editor.buildLine()
		bodyContent.push({ text: `> ${built.line}`, active: false })
		bodyContent.push({ text: 'hint: right opens category · left closes category', active: false })
		bodyContent.push({ text: '', active: false })
		inputCursor = { row: 1, col: 4 + built.cursor }
	}
	if (state.kind === 'confirm' && state.body.length > 0) bodyContent.push({ text: '', active: false })
	// Split on embedded newlines so multi-line bash commands (e.g. heredocs) render
	// inside the popup box instead of breaking the border at column 1.
	for (const line of state.body) {
		for (const sub of String(line).split('\n')) bodyContent.push({ text: sub, active: false })
	}
	if (state.body.length > 0 && state.items.length > 0) tailContent.push({ text: '', active: false })
	for (let i = 0; i < state.items.length; i++) tailContent.push({ text: rowText(state.items[i]!, i === state.selectedIndex), active: i === state.selectedIndex })
	if (state.kind === 'confirm' && state.items.length > 0) tailContent.push({ text: '', active: false })
	if (bodyContent.length === 0 && tailContent.length === 0) bodyContent.push({ text: '', active: false })
	const content = [...bodyContent, ...tailContent]

	// Keep a safety margin away from the terminal's last column and last row.
	// Touching those edges can trigger wrap-pending weirdness in some terminals.
	const rightSlack = cols > 12 ? 1 : 0
	const bottomSlack = rows > 6 ? 1 : 0
	const xMargin = state.kind === 'confirm' ? 1 : 0
	const rawWidth = Math.max(visLen(state.title) + 2, ...content.map((line) => visLen(line.text) + xMargin * 2))
	const maxInnerWidth = Math.max(18, cols - rightSlack - 2)
	const innerWidth = Math.max(18, Math.min(maxInnerWidth, state.preferredInnerWidth ?? rawWidth))
	const contentWidth = Math.max(0, innerWidth - xMargin * 2)
	// For confirm popups, hard-wrap each row to the inner content width so long
	// bash commands and ason-formatted tool inputs stay inside the popup instead
	// of being truncated with '…'. If the wrapped body is taller than the terminal,
	// keep the top and bottom context and use the same "[+ X lines]" wording as
	// tool output renderers for omitted rows.
	let displayContent: PopupRow[]
	if (state.kind === 'confirm') {
		const maxContentRows = Math.max(1, rows - bottomSlack - 2)
		displayContent = clipBodyRows(wrapRows(bodyContent, contentWidth), wrapRows(tailContent, contentWidth), maxContentRows)
	} else {
		displayContent = content
	}
	const title = clipVisual(` ${state.title} `, Math.max(0, innerWidth - 2))
	const titleWidth = visLen(title)
	const top = `┌${title}${'─'.repeat(Math.max(0, innerWidth - titleWidth))}┐`
	const lines = [top]
	for (const line of displayContent) {
		const clipped = clipVisual(line.text, contentWidth)
		const paddedContent = pad(clipped, contentWidth)
		const padded = `${' '.repeat(xMargin)}${paddedContent}${' '.repeat(xMargin)}`
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
