import { expect, test } from 'bun:test'
import { completion } from './completion.ts'

test('one completion replaces the text; several extend it to what they share and are listed by name', () => {
	expect(completion.apply('/c', ['/cd '])).toEqual({ text: '/cd ' })
	expect(completion.apply('/cd ~/pro', ['/cd ~/projects/', '/cd ~/projection/'])).toEqual({ text: '/cd ~/project', choices: ['projects/', 'projection/'] })
	expect(completion.apply('/cd ~/project', ['/cd ~/projects/', '/cd ~/projection/'])).toEqual({ text: '/cd ~/project', choices: ['projects/', 'projection/'] })
	expect(completion.apply('/', ['/cd ', '/help '])).toEqual({ text: '/', choices: ['/cd', '/help'] })
	expect(completion.apply('/x', [])).toEqual({ text: '/x' })
	expect(completion.apply('/go Li', ['/go Lighthouse short story', '/go Lippukiska demand (fork)']).choices).toEqual(['Lighthouse short story', 'Lippukiska demand (fork)'])
})

test('only a command is completed', () => {
	expect(completion.request('s', '/cd ~')).toEqual({ type: 'complete', sessionId: 's', text: '/cd ~' })
	expect(completion.request('s', 'hello')).toBeUndefined()
})
