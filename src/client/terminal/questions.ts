import { questionCrypto } from '../../common/question-crypto.ts'
import { client } from '../app.ts'
import type { QuestionBlock } from '../block-data.ts'
import { clientTransport } from '../transport.ts'
import { lineEditor } from './line-editor.ts'
import type { KeyEvent } from './keys.ts'
import { prompt, type PromptEditorState } from './prompt.ts'

interface QuestionEditorState {
	choiceIndex: number
	text?: PromptEditorState
	secret?: ReturnType<typeof lineEditor.create>
	error?: string
	submitting?: boolean
}

const state = {
	editors: new Map<string, QuestionEditorState>(),
	version: 0,
}

function questionKey(question: QuestionBlock): string {
	let owner = client.state.tabs.find((tab) => tab.history.includes(question))
	if (!owner) owner = client.state.tabs.find((tab) => tab.history.some((block) => block.type === 'question' && block.id === question.id))
	return `${owner?.sessionId ?? client.currentTab()?.sessionId ?? ''}\0${question.id}`
}

function clearResolvedEditors(): void {
	if (state.editors.size === 0) return
	const active = new Set<string>()
	for (const tab of client.state.tabs) {
		for (const block of tab.history) if (block.type === 'question' && block.active) active.add(`${tab.sessionId}\0${block.id}`)
	}
	for (const [key, editor] of state.editors) {
		if (active.has(key)) continue
		editor.secret?.clear()
		state.editors.delete(key)
	}
}

function activeQuestion(): QuestionBlock | undefined {
	clearResolvedEditors()
	return client.currentTab()?.history.find((block): block is QuestionBlock => block.type === 'question' && block.active)
}

function editorFor(question: QuestionBlock): QuestionEditorState {
	const key = questionKey(question)
	let editor = state.editors.get(key)
	if (editor) return editor
	editor = { choiceIndex: 0 }
	if (question.input.kind === 'text') editor.text = prompt.emptyEditorState()
	if (question.input.kind === 'secret') editor.secret = lineEditor.create()
	state.editors.set(key, editor)
	return editor
}

function touch(): void {
	state.version++
}

function sendAnswer(question: QuestionBlock, value: Extract<Parameters<typeof clientTransport.io.appendCommand>[0], { type: 'answer' }>['value']): void {
	const sessionId = client.currentTab()?.sessionId
	if (!sessionId) return
	clientTransport.io.appendCommand({ type: 'answer', sessionId, questionId: question.id, value })
}

function selectChoice(question: QuestionBlock, index: number, submit: boolean): void {
	if (question.input.kind !== 'choice' || question.input.choices.length === 0) return
	const editor = editorFor(question)
	editor.choiceIndex = (index + question.input.choices.length) % question.input.choices.length
	touch()
	if (!submit) return
	const choice = question.input.choices[editor.choiceIndex]
	if (choice) sendAnswer(question, { kind: 'choice', choiceId: choice.id })
}

function submitText(question: QuestionBlock, editor: QuestionEditorState): void {
	if (question.input.kind !== 'text' || !editor.text) return
	const text = prompt.editorStateText(editor.text, true)
	if (!text && !question.input.allowEmpty) {
		editor.error = 'An answer is required.'
		touch()
		return
	}
	sendAnswer(question, { kind: 'text', text })
}

function submitSecret(question: QuestionBlock, editor: QuestionEditorState): void {
	if (question.input.kind !== 'secret' || !editor.secret || editor.submitting) return
	const plaintext = editor.secret.text()
	const bytes = new TextEncoder().encode(plaintext).byteLength
	const maxBytes = question.input.maxBytes
	if (bytes > maxBytes) {
		editor.error = `Secret is limited to ${maxBytes} UTF-8 bytes.`
		touch()
		return
	}
	const sessionId = client.currentTab()?.sessionId
	if (!sessionId) return
	editor.secret.clear()
	editor.submitting = true
	editor.error = undefined
	touch()
	void questionCrypto.encryptSecret(question.input.publicKey, plaintext).then((ciphertext) => {
		clientTransport.io.appendCommand({ type: 'answer', sessionId, questionId: question.id, value: { kind: 'secret', ciphertext } })
	}).catch(() => {
		editor.submitting = false
		editor.error = 'Could not encrypt the secret. Please try again.'
		touch()
		client.requestRender()
	})
}


function handleChoiceKey(question: QuestionBlock, key: KeyEvent): void {
	if (question.input.kind !== 'choice') return
	const editor = editorFor(question)
	if (key.key === 'left' || key.key === 'up' || (key.key === 'tab' && key.shift)) {
		selectChoice(question, editor.choiceIndex - 1, false)
		return
	}
	if (key.key === 'right' || key.key === 'down' || key.key === 'tab') {
		selectChoice(question, editor.choiceIndex + 1, false)
		return
	}
	if (key.key === 'enter') {
		selectChoice(question, editor.choiceIndex, true)
		return
	}
	if (/^[1-9]$/.test(key.key)) {
		const index = Number(key.key) - 1
		if (index < question.input.choices.length) selectChoice(question, index, true)
		return
	}
	if (key.key === 'y' || key.key === 'n') {
		let label = 'no'
		if (key.key === 'y') label = 'yes'
		const index = question.input.choices.findIndex((choice) => choice.label.trim().toLowerCase() === label)
		if (index >= 0) selectChoice(question, index, true)
	}
}

function handleTextKey(question: QuestionBlock, key: KeyEvent): void {
	const editor = editorFor(question)
	if (!editor.text) return
	if (key.key === 'enter' && !key.shift && !key.alt && !key.ctrl && !key.cmd) {
		submitText(question, editor)
		return
	}
	const result = prompt.handleEditorState(editor.text, key, Math.max(1, (process.stdout.columns || 80) - 4))
	editor.text = result.state
	editor.error = undefined
	touch()
}

function handleSecretKey(question: QuestionBlock, key: KeyEvent): void {
	const editor = editorFor(question)
	if (!editor.secret) return
	if (key.key === 'enter' && !key.shift && !key.alt && !key.ctrl && !key.cmd) {
		submitSecret(question, editor)
		return
	}
	if (editor.secret.handleKey(key)) {
		editor.error = undefined
		touch()
	}
}

function handleKey(key: KeyEvent): boolean {
	const question = activeQuestion()
	if (!question) return false
	if (key.key === 'escape') {
		client.sendCommand('abort')
		return true
	}
	if (question.input.kind === 'choice') handleChoiceKey(question, key)
	else if (question.input.kind === 'text') handleTextKey(question, key)
	else handleSecretKey(question, key)
	// Unassigned input must not leak into the frozen ordinary prompt.
	return true
}

function selectedIndex(): number {
	const question = activeQuestion()
	return question ? editorFor(question).choiceIndex : 0
}

function text(question = activeQuestion()): string {
	const saved = question ? editorFor(question).text : undefined
	return saved ? prompt.editorStateText(saved) : ''
}

function choiceIndex(question: QuestionBlock): number {
	return state.editors.get(questionKey(question))?.choiceIndex ?? 0
}

function textRender(question: QuestionBlock, width: number) {
	const editor = editorFor(question)
	if (!editor.text) return undefined
	const built = prompt.buildEditorState(editor.text, width)
	editor.text = built.state
	return built.render
}

function secretDisplay(question = activeQuestion()): string {
	if (!question) return ''
	const secret = editorFor(question).secret?.text() ?? ''
	return '*'.repeat(Array.from(secret).length)
}

function secretCursor(question: QuestionBlock): number {
	const editor = editorFor(question).secret
	if (!editor) return 0
	return Array.from(editor.text().slice(0, editor.cursorPos())).length
}

function error(question: QuestionBlock): string | undefined {
	return editorFor(question).error
}

function reset(): void {
	for (const editor of state.editors.values()) editor.secret?.clear()
	state.editors.clear()
	state.version++
}

export const terminalQuestions = {
	state,
	activeQuestion,
	handleKey,
	selectedIndex,
	choiceIndex,
	text,
	textRender,
	secretDisplay,
	secretCursor,
	error,
	reset,
}
