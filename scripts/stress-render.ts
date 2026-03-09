#!/usr/bin/env bun
// Stress test for the diff engine + block renderer.
// Rapidly mutates blocks and renders frames through the real pipeline.
// Run: bun scripts/stress-render.ts
// Press ctrl-c to exit.

import { render, emptyState, type RenderState, type CursorPos } from '../src/cli/diff-engine.ts'
import { renderBlocks, type Block } from '../src/cli/blocks.ts'
import { getWrappedInputLayout, cursorToWrappedRowCol } from '../src/cli/input.ts'

const { stdout } = process
const W = stdout.columns || 80
const CW = W - 2
const ROWS = stdout.rows || 24
const DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
const MAX_PROMPT_LINES = 12

let state: RenderState = emptyState
let frame = 0
let cursorVisible = true

// ── Shared text fragments ──

const TOOL_OUTPUTS = [
	'~/.hal/src/cli/blocks.ts',
	'~/.hal/src/cli/diff-engine.ts',
	'~/.hal/src/cli/keys.ts',
	'~/.hal/src/cli/prompt.ts',
	'~/.hal/src/cli/colors.ts',
]

const CODE_BLOCK = [
	'Here is some code:',
	'```typescript',
	'function hello(name: string): void {',
	'  console.log(`Hello, ${name}!`)',
	'  for (let i = 0; i < 10; i++) {',
	'    process.stdout.write(`line ${i}\\n`)',
	'  }',
	'}',
	'```',
	'And that is how you do it.',
].join('\n')

const ASSISTANT_TEXT = [
	'Let me investigate this issue.',
	'The problem is in the **diff engine** — when a line contains `ANSI escapes` that cross the patch boundary, the intra-line patch fails and we fall back to full rewrite.',
	CODE_BLOCK,
	'Looking at the `patchLine` function:\n\n```\nfunction patchLine(old, nw) {\n  let i = 0\n  // ...\n}\n```\n\nThis needs fixing.',
]

const QUESTION_LABELS = [
	'Hal asked: Can you run this in a terminal and paste the output?',
	'Hal asked: Should I proceed with the refactor?',
]

// ── Frame builder (mirrors cli.ts buildLines) ──

function buildSep(stateLabel: string, w: number): string {
	const left = ` Opus 4.6 (${stateLabel}) `
	const right = ` host`
	const fill = Math.max(1, w - left.length - right.length)
	return `${DIM}${left}${'─'.repeat(fill)}${right}${RESET}`
}

function buildPromptLines(promptBuf: string, cursorPos: number): { lines: string[]; cursor: { rowOffset: number; col: number } } {
	const layout = getWrappedInputLayout(promptBuf, CW)
	const promptLines = Math.min(layout.lines.length, MAX_PROMPT_LINES)
	const { row: curRow, col: curCol } = cursorToWrappedRowCol(promptBuf, cursorPos, CW)

	let scrollTop = 0
	if (layout.lines.length > promptLines) {
		scrollTop = Math.min(curRow, layout.lines.length - promptLines)
		scrollTop = Math.max(scrollTop, curRow - promptLines + 1)
	}

	const lines: string[] = []
	for (let i = scrollTop; i < scrollTop + promptLines; i++) {
		lines.push(` ${layout.lines[i] ?? ''}`)
	}

	return { lines, cursor: { rowOffset: curRow - scrollTop, col: curCol + 2 } }
}

function buildFrame(blocks: Block[], opts: {
	busy: boolean
	stateLabel?: string
	question?: string
	frozenPrompt?: string
	promptBuf?: string
	promptCursor?: number
}): { lines: string[]; cursor: CursorPos } {
	const contentLines = renderBlocks(blocks, W, cursorVisible)
	const lines = [...contentLines]

	const promptBuf = opts.promptBuf ?? ''
	const promptCursor = opts.promptCursor ?? promptBuf.length
	const p = buildPromptLines(promptBuf, promptCursor)
	const pLines = p.lines.length
	const frozenLines = opts.frozenPrompt ? Math.min(opts.frozenPrompt.split('\n').length, 3) : 0
	const chromeLines = 3 + pLines + (opts.question ? 1 + frozenLines + 1 : 0)
	const available = Math.max(0, ROWS - chromeLines)
	while (lines.length < available) lines.push('')

	// Tab bar
	const tabs = [
		`${DIM} 00-h1n ${RESET}`,
		`${DIM} 00-gfr ${RESET}`,
		`${BOLD}[ 00-stress *]${RESET}`,
		`${DIM} 00-k5j ${RESET}`,
	]
	lines.push(`tabs: ${tabs.join('')}`)

	let cursorOut: CursorPos

	if (opts.question) {
		// Question separator
		const qLeft = ` ${opts.question} `
		const qFill = Math.max(0, W - qLeft.length)
		lines.push(`${DIM}${qLeft}${'─'.repeat(qFill)}${RESET}`)

		// Answer input
		const answerStartRow = lines.length
		lines.push(...p.lines)
		cursorOut = { row: answerStartRow + p.cursor.rowOffset, col: p.cursor.col }

		// Frozen main prompt separator
		const sl = opts.stateLabel ?? 'writing'
		lines.push(buildSep(sl, W))
		if (opts.frozenPrompt) {
			for (const l of opts.frozenPrompt.split('\n').slice(0, 3)) {
				lines.push(`${DIM} ${l}${RESET}`)
			}
		}
	} else {
		// Normal separator + prompt
		const sl = opts.stateLabel ?? (opts.busy ? 'writing' : 'idle')
		lines.push(buildSep(sl, W))
		lines.push(...p.lines)
		cursorOut = { row: lines.length - pLines + p.cursor.rowOffset, col: p.cursor.col }
	}

	// Help bar
	const help = ` ctrl-t new │ ctrl-w close │ ctrl-n/p switch │ ctrl-c quit${opts.busy ? ' busy' : ''} `
	const hPad = W - help.length
	const hLeft = Math.max(0, Math.floor(hPad / 2))
	const hRight = Math.max(0, hPad - hLeft)
	lines.push(`${DIM}${'─'.repeat(hLeft)}${help}${'─'.repeat(hRight)}${RESET}`)

	return { lines, cursor: cursorOut }
}

// ── Scenarios ──

type Scenario = {
	name: string
	frames: number
	build: (i: number) => { lines: string[]; cursor: CursorPos }
}

function scenario_typeAndBackspace(): Scenario {
	// Simulates typing a long message that wraps to multiple prompt lines,
	// then backspacing it away — the shrink path that causes garbling.
	const fullText = 'This is a long message that should wrap across multiple lines in the prompt area, testing backspace behavior when lines shrink'
	return {
		name: 'type-and-backspace',
		frames: 200,
		build: (i) => {
			cursorVisible = i % 2 === 0
			const blocks: Block[] = [
				{ type: 'input', text: 'Hello' },
				{ type: 'assistant', text: 'Sure, go ahead and type.', done: true },
			]
			let promptBuf: string
			let promptCursor: number
			if (i < 100) {
				// Typing phase: add ~1 char per frame
				const end = Math.min(fullText.length, Math.floor((i / 100) * fullText.length))
				promptBuf = fullText.slice(0, end)
				promptCursor = promptBuf.length
			} else {
				// Backspace phase: remove ~1 char per frame
				const remaining = Math.max(0, fullText.length - Math.floor(((i - 100) / 100) * fullText.length))
				promptBuf = fullText.slice(0, remaining)
				promptCursor = promptBuf.length
			}
			return buildFrame(blocks, { busy: false, promptBuf, promptCursor })
		},
	}
}

function scenario_multilinePromptEdit(): Scenario {
	// Multi-line prompt with newlines, cursor moving around, lines appearing/disappearing
	const lines = [
		'first line of input',
		'second line here',
		'third line with more words',
		'fourth line',
		'fifth line at the end',
	]
	return {
		name: 'multiline-edit',
		frames: 150,
		build: (i) => {
			cursorVisible = i % 2 === 0
			const blocks: Block[] = [
				{ type: 'input', text: 'Edit something' },
				{ type: 'assistant', text: 'Go ahead.', done: true },
			]
			// Grow: add lines one by one
			const lineCount = i < 50
				? Math.min(lines.length, Math.floor(i / 10) + 1)
				// Shrink: remove lines
				: i < 100
					? Math.max(1, lines.length - Math.floor((i - 50) / 10))
					// Grow again fast
					: Math.min(lines.length, Math.floor((i - 100) / 5) + 1)
			const promptBuf = lines.slice(0, lineCount).join('\n')
			// Move cursor around within the text
			const promptCursor = Math.min(promptBuf.length, Math.floor(Math.abs(Math.sin(i * 0.15)) * promptBuf.length))
			return buildFrame(blocks, { busy: false, promptBuf, promptCursor })
		},
	}
}

function scenario_streamingWithTyping(): Scenario {
	// Assistant streaming + user has typed something in the prompt
	// The streaming content grows while prompt area stays stable
	return {
		name: 'streaming-with-typing',
		frames: 120,
		build: (i) => {
			cursorVisible = i % 2 === 0
			const blocks: Block[] = [
				{ type: 'input', text: 'Explain the diff engine' },
			]
			// Streaming assistant text grows
			const fullText = ASSISTANT_TEXT.join('\n\n')
			const end = Math.min(fullText.length, Math.floor((i / 100) * fullText.length))
			blocks.push({ type: 'assistant', text: fullText.slice(0, end), done: i >= 100 })
			// User is typing in the prompt while assistant streams
			const typing = 'actually wait, also fix the'
			const typedSoFar = typing.slice(0, Math.floor((i / 120) * typing.length))
			return buildFrame(blocks, {
				busy: i < 100,
				stateLabel: i < 100 ? 'writing' : 'idle',
				promptBuf: typedSoFar,
				promptCursor: typedSoFar.length,
			})
		},
	}
}

function scenario_questionMode(): Scenario {
	return {
		name: 'question-mode',
		frames: 100,
		build: (i) => {
			cursorVisible = i % 2 === 0
			const blocks: Block[] = [
				{ type: 'input', text: 'Refactor the renderer' },
				{ type: 'assistant', text: CODE_BLOCK, done: true },
			]
			if (i < 20) {
				// Idle, user has typed something
				return buildFrame(blocks, { busy: false, promptBuf: 'Yes please do', promptCursor: 13 })
			}
			if (i < 60) {
				// Question appears, user types answer character by character
				const answer = 'Sure, go ahead with the refactor'
				const typed = answer.slice(0, Math.floor(((i - 20) / 40) * answer.length))
				return buildFrame(blocks, {
					busy: true,
					question: QUESTION_LABELS[0],
					frozenPrompt: 'Yes please do',
					promptBuf: typed,
					promptCursor: typed.length,
				})
			}
			if (i < 70) {
				// Question dismissed (esc), pausing
				blocks.push({ type: 'info', text: '[pausing...]' })
				return buildFrame(blocks, { busy: true, promptBuf: 'Yes please do', promptCursor: 13 })
			}
			if (i < 80) {
				blocks.push({ type: 'info', text: '[paused]' })
				return buildFrame(blocks, { busy: false, promptBuf: 'Yes please do', promptCursor: 13 })
			}
			// New question, user types short answer then backspaces
			const phase = i - 80
			const answer = 'no wait'
			let typed: string
			if (phase < 10) {
				typed = answer.slice(0, phase)
			} else {
				typed = answer.slice(0, Math.max(0, answer.length - (phase - 10)))
			}
			return buildFrame(blocks, {
				busy: true,
				question: QUESTION_LABELS[1],
				frozenPrompt: 'Yes please do',
				promptBuf: typed,
				promptCursor: typed.length,
			})
		},
	}
}

function scenario_toolsWithPromptShrink(): Scenario {
	// Multiple tools completing while the prompt area simultaneously changes height
	return {
		name: 'tools-prompt-shrink',
		frames: 150,
		build: (i) => {
			cursorVisible = i % 2 === 0
			const blocks: Block[] = [
				{ type: 'input', text: 'Find and read files' },
			]
			// Tool appearing/completing
			if (i >= 10) {
				const outputLines = Math.min(15, Math.floor((i - 10) / 3))
				const output = Array.from({ length: outputLines }, (_, j) =>
					TOOL_OUTPUTS[j % TOOL_OUTPUTS.length]
				).join('\n')
				blocks.push({
					type: 'tool', name: 'glob', status: i < 50 ? 'streaming' : 'done',
					args: 'src/**/*.ts', output,
					startTime: Date.now() - 2000, endTime: i >= 50 ? Date.now() : undefined,
				})
			}
			if (i >= 55) {
				blocks.push({
					type: 'tool', name: 'read', status: i < 80 ? 'streaming' : 'done',
					args: 'src/cli/diff-engine.ts',
					output: Array.from({ length: Math.min(8, Math.floor((i - 55) / 3)) }, (_, j) =>
						`  ${j + 1}:abc ${'x'.repeat(40 + j * 5)}`
					).join('\n'),
					startTime: Date.now() - 1000, endTime: i >= 80 ? Date.now() : undefined,
				})
			}
			if (i >= 85) {
				const text = ASSISTANT_TEXT[2].slice(0, Math.floor(((i - 85) / 60) * ASSISTANT_TEXT[2].length))
				blocks.push({ type: 'assistant', text, done: i >= 140 })
			}

			// Prompt oscillates between 1 and 3 lines
			const phase = Math.sin(i * 0.2)
			let promptBuf: string
			if (phase > 0.3) {
				promptBuf = 'some long text that wraps and wraps and creates multiple prompt lines in the terminal'
			} else if (phase > -0.3) {
				promptBuf = 'medium text here'
			} else {
				promptBuf = ''
			}

			return buildFrame(blocks, {
				busy: i < 140,
				stateLabel: i < 50 ? 'tool' : i < 85 ? 'tool' : i < 140 ? 'writing' : 'idle',
				promptBuf,
				promptCursor: promptBuf.length,
			})
		},
	}
}

function scenario_rapidShrinkGrow(): Scenario {
	return {
		name: 'shrink-grow',
		frames: 100,
		build: (i) => {
			cursorVisible = i % 2 === 0
			const lineCount = 3 + Math.floor(Math.sin(i * 0.3) * 8 + 8)
			const text = Array.from({ length: lineCount }, (_, j) =>
				`Line ${j}: ${'x'.repeat(20 + (j * 7) % 30)}`
			).join('\n')
			const blocks: Block[] = [
				{ type: 'input', text: `Iteration ${i}` },
				{ type: 'assistant', text, done: i % 20 > 15 },
			]
			return buildFrame(blocks, { busy: i % 20 <= 15, promptBuf: 'watching...', promptCursor: 11 })
		},
	}
}

// ── Main loop ──

const scenarios: Scenario[] = [
	scenario_typeAndBackspace(),
	scenario_multilinePromptEdit(),
	scenario_streamingWithTyping(),
	scenario_questionMode(),
	scenario_toolsWithPromptShrink(),
	scenario_rapidShrinkGrow(),
]

// Hide cursor, clear screen
stdout.write('\x1b[?25l\x1b[2J\x1b[H')

process.on('SIGINT', () => {
	// Move below last frame, show cursor, print summary — don't clear
	const down = state.lines.length - state.cursorRow
	stdout.write(`\x1b[${down}B\r\n\x1b[?25h`)
	console.log(`Stress test done. ${frame} frames, scenario: ${scenarios[scenarioIdx]?.name}:${scenarioFrame}`)
	process.exit(0)
})

const FRAME_MS = 10

let scenarioIdx = 0
let scenarioFrame = 0

function tick() {
	const sc = scenarios[scenarioIdx]
	const { lines, cursor } = sc.build(scenarioFrame)
	const { buf } = render(lines, state, cursor, ROWS)
	state = { lines, cursorRow: cursor.row, cursorCol: cursor.col }
	if (buf) stdout.write(buf)

	frame++
	scenarioFrame++

	if (scenarioFrame >= sc.frames) {
		scenarioFrame = 0
		scenarioIdx++
		if (scenarioIdx >= scenarios.length) {
			scenarioIdx = 0
			state = emptyState
		}
	}

	setTimeout(tick, FRAME_MS)
}

// Label each scenario transition
const origTick = tick
function labeledTick() {
	if (scenarioFrame === 0) {
		const sc = scenarios[scenarioIdx]
		// Flash scenario name briefly by injecting it into state
		state = emptyState
	}
	origTick()
}

console.log(`Stress test: ${scenarios.length} scenarios, ${FRAME_MS}ms/frame`)
console.log('Scenarios: ' + scenarios.map(s => s.name).join(', '))
console.log('Press Ctrl-C to stop.\n')

setTimeout(() => {
	state = emptyState
	tick()
}, 500)
