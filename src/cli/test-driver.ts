// Headless TUI test driver. Drives keybindings + prompt without a terminal.

import { keybindings, type InputContext } from './keybindings.ts'
import type { KeyEvent } from './keys.ts'
import { prompt } from './prompt.ts'

export class TestDriver {
	sent: { type: string; text?: string }[] = []
	blocks: any[] = []
	inputHistory: string[] = []
	renders = 0
	private ctx: InputContext

	constructor() {
		prompt.reset()
		prompt.setHistory(this.inputHistory)
		this.ctx = {
			send: (type, text) => { this.sent.push({ type, text }) },
			activeTab: () => ({ blocks: this.blocks, busy: false, info: { topic: '.hal', workingDir: '~/.hal' } }),
			tabs: () => [{ sessionId: '01-test', info: { topic: '.hal', workingDir: '~/.hal' } }],
			activeTabIndex: () => 0,
			saveDraft: () => {},
			onSubmit: () => {},
			nextTab: () => {},
			prevTab: () => {},
			switchToTab: () => {},
			clearQuestion: () => {},
			markPausing: () => {},
			doRender: () => { this.renders++ },
			redraw: () => { this.renders++ },
			contentWidth: () => 80,
			quit: () => {},
			restart: () => {},
			suspend: () => {},
		}
	}

	press(key: string, mods?: Partial<KeyEvent>): void {
		const k: KeyEvent = { key, char: '', ctrl: false, alt: false, shift: false, cmd: false, ...mods }
		keybindings.handleInput(k, this.ctx)
	}

	type(text: string): void {
		for (const ch of text) this.press(ch, { char: ch })
	}

	enter(): void { this.press('enter') }
	escape(): void { this.press('escape') }

	submit(text: string): void {
		this.type(text)
		this.enter()
	}

	get promptText(): string { return prompt.text() }
	get cursor(): number { return prompt.cursorPos() }
	get selection(): [number, number] | null { return prompt.selection() }

	reset(): void {
		this.sent.length = 0
		this.blocks.length = 0
		this.inputHistory.length = 0
		this.renders = 0
		prompt.reset()
		prompt.setHistory(this.inputHistory)
	}
}
