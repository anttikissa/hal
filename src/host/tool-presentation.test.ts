import { afterEach, expect, test } from 'bun:test'
import { blocks, type ToolCallBlock, type ToolResultBlock } from '../common/blocks.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { transcript } from '../common/transcript.ts'
import { toolPresentation } from '../common/tool-presentation.ts'
import { toolPresentations } from './tool-presentation.ts'
import { historyCheck } from './history-check.ts'
import { tools } from './tools.ts'
import { nativeTool } from './native-tool.ts'

const original = toolPresentations.present
const call: ToolCallBlock = {
	type: 'tool_call',
	id: 'edit-1',
	name: 'example-edit',
	input: { files: ['a.ts', 'b.ts'] },
}
afterEach(() => {
	toolPresentations.present = original
})

test('presentation survives live and persisted replay but never enters provider messages', () => {
	toolPresentations.present = (_call, result) => ({
		title: result ? 'Edited a.ts, b.ts' : 'Edit a.ts, b.ts',
		blocks: result ? [{ kind: 'diff', path: 'a.ts', text: { from: 0, to: result.output.length } }] : [],
	})
	let start = nativeTool.arrived(call)
	let end = toolPresentations.attach(call, {
		type: 'tool_result',
		id: call.id,
		output: '-1 before\n+1 after\n',
	} as ToolResultBlock)
	let records: HistoryRecord[] = [
		{ type: 'assistant', block: start, ts: '2026-10-10T00:00:00Z', n: 1 },
		{ type: 'user', blocks: [end], ts: '2026-10-10T00:00:01Z', n: 2 },
	]
	let loaded = JSON.parse(JSON.stringify(records)).map(historyCheck.check)
	expect(loaded).toEqual(records)
	let turn = blocks.newTurn('test')
	blocks.apply(turn, start)
	expect(transcript.blockItems(turn.blocks, [1], 0)).toEqual(transcript.blockItems([start], [1], 0))
	expect(transcript.resultItem(end).type).toBe('tool-result')
	expect(transcript.resultItem(end)).toMatchObject({ presentation: end.presentation, output: end.output })
	let ordinary = records.map((r) =>
		r.type === 'assistant'
			? { ...r, block: call }
			: { ...r, blocks: [{ type: 'tool_result', id: call.id, output: end.output }] },
	) as HistoryRecord[]
	expect(replay.toMessages(loaded)).toEqual(replay.toMessages(ordinary))
	expect(toolPresentation.text(end.presentation!.blocks[0]!, end.output)).toBe(end.output)
})

test('a broken presentation keeps the execution outcome and reaches model and user', async () => {
	toolPresentations.present = () => {
		throw new Error('renderer exploded with full details')
	}
	let result = await tools.run(
		{ ...call, name: 'missing-tool' },
		{ cwd: '/tmp', sessionId: 'test', signal: new AbortController().signal },
	)
	expect(result).toMatchObject({
		isError: true,
		output: expect.stringMatching(/^Error: 'missing-tool' is not a provider tool/),
	})
	expect(result.presentationError).toContain('renderer exploded with full details')
	expect(result.presentationError).toContain('Input:')
	expect(transcript.resultItem(result)).toMatchObject({ presentationError: result.presentationError })
	let records: HistoryRecord[] = [
		{ type: 'assistant', block: call, ts: '' },
		{ type: 'user', blocks: [result], ts: '' },
	]
	expect(JSON.stringify(replay.toMessages(records))).toContain('Display error (execution outcome unchanged)')
})

// Task m3a: a plugin tool's card never takes its title from the command.
test('a plugin tool gets a card: purpose title, command as code, result, kind and look', () => {
	let all = tools.all
	let evalTool = {
		name: 'eval',
		description: 'Run code.',
		parameters: { type: 'object' as const, properties: { code: { type: 'string' } }, required: ['code'] },
		card: { command: 'code', language: 'javascript', hue: 265, icon: 'code' },
		run: async () => '2',
	}
	let taskTool = {
		name: 'task',
		description: 'Show a task.',
		readOnly: true as const,
		parameters: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
		run: async () => 'm3a: Cards',
	}
	tools.all = () => [...all(), evalTool, taskTool]
	try {
		let [run] = nativeTool.expand({
			type: 'tool_call',
			id: 'e',
			name: 'tool',
			input: { cmd: 'EVAL /* Add */ "return 1+1"' },
		})
		expect(run!.presentation).toEqual({
			title: 'Eval Add',
			blocks: [{ kind: 'code', text: 'return 1+1', language: 'javascript' }],
			readOnly: false,
			icon: 'code',
			hue: 265,
		})
		let done = toolPresentations.attach(run!, { type: 'tool_result', id: 'e', output: '2' } as ToolResultBlock)
		expect(done.presentation!.blocks[1]).toEqual({ kind: 'text', text: { from: 0, to: 1 } })
		let failed = toolPresentations.attach(run!, {
			type: 'tool_result',
			id: 'e',
			output: 'Error: x',
			isError: true,
		} as ToolResultBlock)
		expect(failed.presentation!.blocks).toHaveLength(1)
		let [task] = nativeTool.expand({ type: 'tool_call', id: 't', name: 'tool', input: { cmd: 'TASK "m3a"' } })
		expect(task!.presentation).toEqual({
			title: 'Task',
			blocks: [{ kind: 'text', text: 'id: m3a' }],
			readOnly: true,
			icon: 'sparkle',
		})
	} finally {
		tools.all = all
	}
})

test('invalid output references fall back before persistence and corrupt recorded data fails', () => {
	toolPresentations.present = () => ({ title: 'Edited', blocks: [{ kind: 'diff', text: { from: -1, to: 99 } }] })
	let result = toolPresentations.attach(call, { type: 'tool_result', id: call.id, output: 'ok' } as ToolResultBlock)
	expect(result.output).toBe('ok')
	expect(result.isError).toBeUndefined()
	expect(result.presentation).toBeUndefined()
	expect(result.presentationError).toContain('Invalid tool presentation output range')
	expect(() =>
		historyCheck.check({
			type: 'user',
			blocks: [{ ...result, presentation: toolPresentations.present(call) }],
			ts: '',
		}),
	).toThrow('Invalid tool presentation output range')
})
