import { afterEach, expect, test } from 'bun:test'
import { chromeFade } from './chrome-fade.ts'
import { terminalBackground } from './terminal-background.ts'
import { cursor } from './cursor.ts'
import { termCaps } from '../../utils/term-caps.ts'
import { visLen } from '../../utils/strings.ts'

const originalTick = cursor.heartbeatTick
const originalTruecolor = termCaps.config.truecolor

afterEach(() => {
	cursor.heartbeatTick = originalTick
	termCaps.config.truecolor = originalTruecolor
	terminalBackground.state.background = null
	chromeFade.reset()
})

function frame(target: number, tick: number, key = 'tabsOpacity'): string {
	cursor.heartbeatTick = () => tick
	const lines = ['history', '\x1b[38;2;200;100;50m界 tab\x1b[0m']
	chromeFade.apply(lines, 1, key, target)
	expect(lines[0]).toBe('history')
	return lines[1]!
}

test('unknown background and non-truecolor terminals reveal instantly without scheduling animation', () => {
	const normal = frame(0, 0)
	expect(frame(1, 1)).toBe(normal)
	expect(chromeFade.active()).toBe(false)
	chromeFade.reset()
	terminalBackground.state.background = [255, 255, 255]
	termCaps.config.truecolor = false
	frame(0, 0)
	expect(frame(1, 1)).toBe(normal)
	expect(chromeFade.active()).toBe(false)
})

test('zero-to-one reveals interpolate toward the theme in twelve heartbeat steps', () => {
	terminalBackground.state.background = [20, 40, 60]
	termCaps.config.truecolor = true
	const normal = frame(0, 0)
	const hidden = frame(1, 4)
	expect(hidden.trim()).toBe('')
	expect(visLen(hidden)).toBe(visLen(normal))
	expect(chromeFade.active()).toBe(true)
	const middle = frame(1, 10)
	expect(middle).toContain('\x1b[38;2;110;70;55m')
	expect(visLen(middle)).toBe(visLen(normal))
	expect(frame(1, 16)).toBe(normal)
	expect(chromeFade.active()).toBe(false)
})

test('existing visible chrome does not replay on startup, and sections fade independently', () => {
	terminalBackground.state.background = [0, 0, 0]
	termCaps.config.truecolor = true
	expect(frame(1, 0)).toContain('tab')
	expect(chromeFade.active()).toBe(false)
	frame(0, 0, 'promptOpacity')
	frame(1, 1, 'promptOpacity')
	expect(chromeFade.isFading('promptOpacity')).toBe(true)
	expect(chromeFade.isFading('tabsOpacity')).toBe(false)
	frame(0, 2, 'promptOpacity')
	expect(chromeFade.active()).toBe(false)
})

test('light backgrounds fade both foreground and panel backgrounds, retaining resets and geometry', () => {
	terminalBackground.state.background = [240, 240, 240]
	const line = '\x1b[48;2;0;40;60m\x1b[38;2;80;100;120mInput\x1b[0m tail'
	const result = chromeFade.blend(line, 0.5)
	expect(result).toContain('\x1b[48;2;120;140;150m')
	expect(result).toContain('\x1b[38;2;160;170;180m')
	expect(result).toContain('\x1b[0m\x1b[38;2;160;170;180m tail')
	expect(result.endsWith('\x1b[0m')).toBe(true)
	expect(visLen(result)).toBe(visLen(line))
})

test('a late background reply does not restart an already-visible section', () => {
	frame(0, 0)
	const normal = frame(1, 1)
	terminalBackground.state.background = [255, 255, 255]
	expect(frame(1, 3)).toBe(normal)
	expect(chromeFade.active()).toBe(false)
})
