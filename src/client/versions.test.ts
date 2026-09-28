// The host ≠ peer notice (task n1), as the terminal's view shows it.
import { afterEach, expect, test } from 'bun:test'
import type { Event } from '../common/protocol.ts'
import { app } from './app.ts'
import { render } from './render.ts'
import { versions } from './versions.ts'

const show = render.show
afterEach(() => {
	render.show = show
	versions.state = { own: undefined, host: undefined, newCode: false }
	app.reset()
})

const snapshot: Event = { type: 'snapshot', sessionId: 's', snapshot: { meta: { id: 's', cwd: '/', model: 'm', createdAt: '' }, history: [], state: { type: 'idle' } } }

test('a peer running other code than its host says both versions; equal ones say nothing', () => {
	render.show = () => {}
	app.onEvent(snapshot)
	versions.state.own = 'bcd4321'
	versions.state.host = 'abcd123'
	expect(app.view().notice).toBe('host runs abcd123, this peer bcd4321')
	versions.state.host = 'bcd4321'
	expect(app.view().notice).toBeUndefined()
	// Not known yet on either side: no notice.
	versions.state.host = undefined
	expect(app.view().notice).toBeUndefined()
})

test('a passing notice wins over the version notice, which comes back after', () => {
	versions.state.own = 'bcd4321'
	versions.state.host = 'abcd123'
	app.state.notice = 'model refused: unknown'
	expect(app.view().notice).toBe('model refused: unknown')
	app.state.notice = undefined
	expect(app.view().notice).toContain('host runs abcd123')
})
