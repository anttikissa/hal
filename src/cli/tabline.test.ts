import { describe, test, expect } from 'bun:test'
import { renderTabline } from './tabline.ts'

describe('renderTabline', () => {
	const tabs = [
		{ label: '1 .hal', busy: true, active: true },
		{ label: '2 work', busy: false, active: false },
		{ label: '3 tmp', busy: true, active: false },
		{ label: '4 etc', busy: false, active: false },
	]

	test('full style when it fits', () => {
		const line = renderTabline(tabs, 80)
		expect(line).toContain('[1 .hal]')
		expect(line).toContain(' 2 work ')
	})

	test('fallback to bracket compact style', () => {
		const line = renderTabline(tabs, 20)
		expect(line).toContain('[1x]')
		expect(line).toContain('[2 ]')
	})

	test('fallback to bare compact style', () => {
		const line = renderTabline(tabs, 10)
		expect(line).toContain('1x')
		expect(line.length).toBeLessThanOrEqual(10)
	})

	test('final fallback never exceeds width', () => {
		const line = renderTabline(tabs, 6)
		expect(line.length).toBeLessThanOrEqual(6)
	})
})
