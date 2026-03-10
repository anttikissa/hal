import { test, expect, describe } from 'bun:test'
import { createBlinkParser, DEFAULT_BLINK_MS, type BlinkSegment } from './blink.ts'

function parse(chunks: string[]): BlinkSegment[] {
	const p = createBlinkParser()
	const out: BlinkSegment[] = []
	for (const c of chunks) out.push(...p.feed(c))
	out.push(...p.flush())
	return out
}

describe('BlinkParser', () => {
	test('plain text passes through', () => {
		expect(parse(['hello world'])).toEqual([
			{ type: 'text', text: 'hello world' },
		])
	})

	test('single blink tag', () => {
		expect(parse(['before<blink />after'])).toEqual([
			{ type: 'text', text: 'before' },
			{ type: 'pause', ms: DEFAULT_BLINK_MS },
			{ type: 'text', text: 'after' },
		])
	})

	test('blink with custom ms', () => {
		expect(parse(['<blink ms="400"/>'])).toEqual([
			{ type: 'pause', ms: 400 },
		])
	})

	test('multiple blinks', () => {
		expect(parse(['a<blink />b<blink ms="200" />c'])).toEqual([
			{ type: 'text', text: 'a' },
			{ type: 'pause', ms: DEFAULT_BLINK_MS },
			{ type: 'text', text: 'b' },
			{ type: 'pause', ms: 200 },
			{ type: 'text', text: 'c' },
		])
	})

	test('blink split across chunks', () => {
		expect(parse(['hello<bli', 'nk />world'])).toEqual([
			{ type: 'text', text: 'hello' },
			{ type: 'pause', ms: DEFAULT_BLINK_MS },
			{ type: 'text', text: 'world' },
		])
	})

	test('blink ms split across chunks', () => {
		expect(parse(['text<blink ms="3', '00" />more'])).toEqual([
			{ type: 'text', text: 'text' },
			{ type: 'pause', ms: 300 },
			{ type: 'text', text: 'more' },
		])
	})

	test('partial tag at end with no completion becomes text on flush', () => {
		expect(parse(['hello<bl'])).toEqual([
			{ type: 'text', text: 'hello' },
			{ type: 'text', text: '<bl' },
		])
	})

	test('just a < at end is held then flushed', () => {
		expect(parse(['end<'])).toEqual([
			{ type: 'text', text: 'end' },
			{ type: 'text', text: '<' },
		])
	})

	test('empty input', () => {
		expect(parse([])).toEqual([])
	})

	test('blink at start', () => {
		expect(parse(['<blink />hello'])).toEqual([
			{ type: 'pause', ms: DEFAULT_BLINK_MS },
			{ type: 'text', text: 'hello' },
		])
	})

	test('blink at end', () => {
		expect(parse(['hello<blink />'])).toEqual([
			{ type: 'text', text: 'hello' },
			{ type: 'pause', ms: DEFAULT_BLINK_MS },
		])
	})
})
