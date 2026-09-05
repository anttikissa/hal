import { afterEach, expect, test } from 'bun:test'
import { processControl } from './process-control.ts'

const originalExit = processControl.io.exit

function reset(): void {
	processControl.io.exit = originalExit
	processControl.state.exitCode = null
	processControl.state.nextTurnScheduled = false
}

afterEach(reset)

test('restart waits for an explicit durable boundary', () => {
	const exits: number[] = []
	processControl.io.exit = (code) => { exits.push(code) }

	processControl.requestRestart()
	expect(exits).toEqual([])
	expect(processControl.state.exitCode).toBe(100)

	processControl.exitIfRequested()
	expect(exits).toEqual([100])
	expect(processControl.state.exitCode).toBeNull()
})

test('next-turn exit defers without an arbitrary wall-clock delay', async () => {
	const exits: number[] = []
	processControl.io.exit = (code) => { exits.push(code) }

	processControl.requestExit(42)
	processControl.exitOnNextTurn()
	expect(exits).toEqual([])

	await new Promise<void>((resolve) => setImmediate(resolve))
	expect(exits).toEqual([42])
})
