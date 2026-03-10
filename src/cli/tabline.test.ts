import { describe, test, expect } from 'bun:test'
import { renderTabline } from './tabline.ts'

function strip(s: string): string {
	return s.replace(/\x1b\[[^m]*m/g, '')
}

describe('renderTabline', () => {
	const tabs = [
		{ label: '1 .hal', busy: true, active: true },
		{ label: '2 work', busy: false, active: false },
		{ label: '3 tmp', busy: true, active: false },
		{ label: '4 etc', busy: false, active: false },
	]

	test('full style when it fits', () => {
		const line = renderTabline(tabs, 80, true)
		const plain = strip(line)
		expect(plain).toContain('[1▪.hal]')
		expect(plain).toContain(' 2 work ')
		expect(plain).toContain(' 3▪tmp ')
	})

	test('busy indicator hidden when busyVisible=false', () => {
		const line = renderTabline(tabs, 80, false)
		const plain = strip(line)
		expect(plain).toContain('[1 .hal]')
		expect(plain).not.toContain('▪')
	})

	test('active tab is bright white', () => {
		const line = renderTabline(tabs, 80, true)
		expect(line).toContain('\x1b[97m')
	})

	test('inactive tab is dim', () => {
		const line = renderTabline(tabs, 80, true)
		expect(line).toContain('\x1b[38;5;245m')
	})

	test('degrades to short titles', () => {
		const line = renderTabline(tabs, 30, true)
		const plain = strip(line)
		// Should still have numbers and busy indicators
		expect(plain).toContain('1')
		expect(plain).toContain('2')
	})

	test('degrades to numbers + busy', () => {
		const line = renderTabline(tabs, 18, true)
		const plain = strip(line)
		expect(plain).toContain('[1▪]')
		expect(plain).toContain(' 2 ')
	})

	test('degrades to just numbers', () => {
		const line = renderTabline(tabs, 14, true)
		const plain = strip(line)
		expect(plain).toContain('[1]')
		expect(plain).toContain(' 2 ')
	})

	test('never exceeds width', () => {
		for (const w of [6, 10, 14, 20, 30, 40, 80]) {
			const line = renderTabline(tabs, w, true)
			expect(strip(line).length).toBeLessThanOrEqual(w)
		}
	})

	test('long tab names are truncated', () => {
		const longTabs = [
			{ label: '1 my-very-long-project-name', busy: false, active: true },
			{ label: '2 another-long-name-here', busy: false, active: false },
		]
		const line = renderTabline(longTabs, 40, true)
		const plain = strip(line)
		expect(plain).toContain('…')
	})

	test('empty tabs returns empty', () => {
		expect(renderTabline([], 80)).toBe('')
	})
})
