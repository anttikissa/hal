import { describe, expect, test } from 'bun:test'
import type { Block } from './blocks.ts'
import { blocksSignature } from './block-signature.ts'

function sig(blocks: Block[]): number {
	return blocksSignature(blocks)
}

describe('blocksSignature', () => {
	test('is stable for equal inputs', () => {
		const blocks: Block[] = [
			{ type: 'input', text: 'hello' },
			{ type: 'assistant', text: 'world', done: true },
		]
		expect(sig(blocks)).toBe(sig(blocks))
	})

	test('changes when assistant text changes with same length', () => {
		const a: Block[] = [{ type: 'assistant', text: 'abcXdef', done: true }]
		const b: Block[] = [{ type: 'assistant', text: 'abcYdef', done: true }]
		expect(sig(a)).not.toBe(sig(b))
	})

	test('changes when tool output changes with same length', () => {
		const base = {
			type: 'tool' as const,
			name: 'bash',
			status: 'done' as const,
			args: 'echo hi',
			startTime: 1,
			sessionId: 's',
		}
		const a: Block[] = [{ ...base, output: 'line a' }]
		const b: Block[] = [{ ...base, output: 'line b' }]
		expect(sig(a)).not.toBe(sig(b))
	})

	test('changes when tool status changes', () => {
		const base = {
			type: 'tool' as const,
			name: 'bash',
			args: 'echo hi',
			output: 'ok',
			startTime: 1,
			sessionId: 's',
		}
		const running: Block[] = [{ ...base, status: 'running' }]
		const done: Block[] = [{ ...base, status: 'done' }]
		expect(sig(running)).not.toBe(sig(done))
	})
})
