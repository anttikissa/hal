import { expect, test } from 'bun:test'
import { modals } from './modals.ts'

const key = (key: string, text?: string) => ({ key, text })
const search = { text: 'Models', fields: [{ type: 'text' as const, name: 'search', label: 'Search' }] }

function press(st = modals.open({ title: 'Models', form: search, items: ['a', 'b', 'c'] }), ...keys: string[]) {
	let action
	for (let k of keys) ({ state: st, action } = modals.step(st, key(k, k.length === 1 ? k : undefined)))
	return { st, action }
}

test('up and down move through the list and stop at its ends', () => {
	expect(press(undefined, 'down', 'down').st.selected).toBe(2)
	expect(press(undefined, 'down', 'down', 'down', 'down').st.selected).toBe(2)
	expect(press(undefined, 'down', 'up', 'up').st.selected).toBe(0)
})

test('typing goes to the search box and starts the list from the top', () => {
	let { st } = press(undefined, 'down', 'down', 'o', 'p')
	expect(st.form!.values[0]).toBe('op')
	expect(st.selected).toBe(0)
	// Moving the cursor in the box keeps the place in the list.
	expect(press(st, 'down', 'left').st.selected).toBe(1)
})

test('Enter ends the modal with the answers and the selected item; Escape dismisses it', () => {
	expect(press(undefined, 'x', 'down', 'enter').action).toEqual({ type: 'submit', answers: { search: 'x' }, item: 1 })
	expect(press(undefined, 'escape').action).toEqual({ type: 'cancel' })
	// An empty list selects nothing.
	let empty = modals.open({ title: 'Models', form: search })
	expect(press(empty, 'enter').action).toEqual({ type: 'submit', answers: { search: '' } })
})

test('the list scrolls as little as it can to keep the selection in view', () => {
	expect(modals.scroll(0, 3, 20, 5)).toBe(0)
	expect(modals.scroll(0, 7, 20, 5)).toBe(3)
	expect(modals.scroll(3, 4, 20, 5)).toBe(3)
	expect(modals.scroll(3, 1, 20, 5)).toBe(1)
	// Never past the end, e.g. when the list got shorter or the box taller.
	expect(modals.scroll(15, 19, 20, 8)).toBe(12)
	expect(modals.scroll(9, 0, 3, 5)).toBe(0)
})
