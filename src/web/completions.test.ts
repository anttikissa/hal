import { expect, test } from 'bun:test'
import { completions } from './completions.ts'

test('candidates show only descriptions the host or the command list supplies (task 4qh)', () => {
	let commands = completions.receive('/c', ['/cd ', '/clear '])!
	expect(commands.choices.map((c) => c.label)).toEqual(['/cd', '/clear'])
	expect(commands.choices[0]!.description).toContain('directory')
	let paths = completions.receive('/cd ~/pro', ['/cd ~/projects/', '/cd ~/profile.pdf'])!
	expect(paths.choices.map((c) => c.label)).toEqual(['projects/', 'profile.pdf'])
	expect(paths.choices.map((c) => c.description)).toEqual(['', ''])
	expect(paths.choices[1]!.value).toBe('/cd ~/profile.pdf')
	let go = completions.receive('/go ~/h', ['/go ~/hal', '/go ~/hal-old'], undefined, ['directory', 'directory'])!
	expect(go.choices.map((c) => c.description)).toEqual(['directory', 'directory'])
})

test('model descriptions stay aligned and preserve menu identity while filtering', () => {
	let known = { input: '/model gpt', items: ['/model gpt', '/model gpt-6.1', '/model gpt-6'], descriptions: ['openai/gpt-6-sol', 'openai/gpt-6.1-sol', 'openai/gpt-6-sol'] }
	let menu = completions.receive(known.input, known.items, undefined, known.descriptions)!
	let predicted = completions.predict('/model gpt-6', known, menu)!
	expect(predicted.choices.map((c) => c.description)).toEqual(['openai/gpt-6.1-sol', 'openai/gpt-6-sol'])
	expect(predicted.choices[0]).toBe(menu.choices[1])
	expect(completions.receive('/model gpt-6', known.items.slice(1), predicted, known.descriptions.slice(1))).toBe(predicted)
})
