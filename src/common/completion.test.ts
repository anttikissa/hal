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

test('prefix matches complete without losing word-match alternatives or qualified labels', () => {
	let items = ['/model astra', '/model openrouter/openai/gpt-6-astra', '/model openai/gpt-astra-latest']
	expect(completion.apply('/model astr', items)).toEqual({ text: '/model astra', choices: ['astra', 'openrouter/openai/gpt-6-astra', 'openai/gpt-astra-latest'] })
	expect(completion.apply('/model ast', [...items, '/model astra-pro']).text).toBe('/model astra')
	expect(completion.apply('/model fab', ['/model anthropic/claude-fable-5-1']).text).toBe('/model anthropic/claude-fable-5-1')
	expect(completion.apply('/model big', ['/model acme/big-1', '/model acme/big-2'])).toEqual({ text: '/model acme/big-', choices: ['big-1', 'big-2'] })
})
