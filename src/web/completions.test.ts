import { expect, test } from 'bun:test'
import { completions } from './completions.ts'

test('slash and path candidates use host values with useful labels and descriptions', () => {
	let commands = completions.receive('/c', ['/cd ', '/clear '])!
	expect(commands.choices.map((c) => c.label)).toEqual(['/cd', '/clear'])
	expect(commands.choices[0]!.description).toContain('directory')
	let paths = completions.receive('/cd ~/pro', ['/cd ~/projects/', '/cd ~/profile.pdf'])!
	expect(paths.choices.map((c) => c.label)).toEqual(['projects/', 'profile.pdf'])
	expect(paths.choices[0]!.description).toBe('directory')
	expect(paths.choices[1]!.value).toBe('/cd ~/profile.pdf')
})
