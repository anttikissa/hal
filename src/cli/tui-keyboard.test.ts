import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse as parseAson } from '../utils/ason.ts'
import { _testTuiKeys } from './tui.ts'
import { parseKeys } from './tui-text.ts'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const GHOSTTY_FIXTURE_PATH = new URL('../tests/fixtures/keys/keys-ghostty.ason', import.meta.url)
const KNOWN_CMD_V_CLIPBOARD = 'hal-capture-cmd-v'

type FixtureToken = {
	hex: string
}

type FixtureStep = {
	stepId: string
	status: string
	bytes: number[]
	tokens: FixtureToken[]
}

type FixtureProfile = {
	id: string
	steps: FixtureStep[]
}

type FixtureDoc = {
	terminalLabel?: string
	profiles?: FixtureProfile[]
}

// These tests are intentionally pinned to the Ghostty capture fixture (HAL `hal11` profile).
// They document what Ghostty currently emits and how HAL normalizes it.
const ghosttyDoc = loadGhosttyFixture()
const ghosttyHal11 = getProfile(ghosttyDoc, 'hal11')
const ghosttySteps = new Map(ghosttyHal11.steps.map((step) => [step.stepId, step]))

function loadGhosttyFixture(): FixtureDoc {
	const raw = readFileSync(GHOSTTY_FIXTURE_PATH, 'utf8')
	return parseAson(raw) as FixtureDoc
}

function getProfile(doc: FixtureDoc, id: string): FixtureProfile {
	const profile = doc.profiles?.find((p) => p.id === id)
	if (!profile) throw new Error(`Missing profile in fixture: ${id}`)
	return profile
}

function getStep(id: string): FixtureStep {
	const step = ghosttySteps.get(id)
	if (!step) throw new Error(`Missing Ghostty fixture step: ${id}`)
	return step
}

function bytesToRaw(bytes: number[]): string {
	return Buffer.from(bytes).toString('utf8')
}

function textToHex(text: string): string {
	return [...Buffer.from(text)].map((b) => b.toString(16).padStart(2, '0')).join(' ')
}

function parseFixtureStepTokens(stepId: string): string[] {
	const step = getStep(stepId)
	return parseKeys(bytesToRaw(step.bytes), PASTE_START, PASTE_END)
}

function normalizeTokens(tokens: string[]): string[] {
	_testTuiKeys.resetState()
	const normalized: string[] = []
	for (const token of tokens) {
		const out = _testTuiKeys.normalizeKittyKey(token)
		if (out !== null) normalized.push(out)
	}
	return normalized
}

function normalizeFixtureStep(stepId: string): string[] {
	return normalizeTokens(parseFixtureStepTokens(stepId))
}

describe('tui keyboard fixture baseline (Ghostty, hal11)', () => {
	it('loads the Ghostty fixture', () => {
		expect(ghosttyDoc.terminalLabel).toBe('ghostty')
		expect(ghosttyHal11.id).toBe('hal11')
		expect(ghosttyHal11.steps.length).toBeGreaterThan(30)
	})

	it('replays parseKeys tokenization for all captured Ghostty steps', () => {
		for (const step of ghosttyHal11.steps) {
			const parsed = parseKeys(bytesToRaw(step.bytes), PASTE_START, PASTE_END)
			const parsedHex = parsed.map(textToHex)
			const fixtureHex = (step.tokens ?? []).map((t) => t.hex)
			expect(parsedHex, step.stepId).toEqual(fixtureHex)
		}
	})
})

describe('Kitty CSI-u parsing regressions', () => {
	it('accepts compact and extended CSI-u shapes used by Kitty/Ghostty', () => {
		expect(_testTuiKeys.parseKittyCsiUKey('\x1b[97u')).toMatchObject({
			codepoint: 97,
			rawModifier: 1,
			eventType: 1,
		})
		expect(_testTuiKeys.parseKittyCsiUKey('\x1b[97;1:3u')).toMatchObject({
			codepoint: 97,
			rawModifier: 1,
			eventType: 3,
		})
		expect(_testTuiKeys.parseKittyCsiUKey('\x1b[97;;97u')).toMatchObject({
			codepoint: 97,
			rawModifier: 1,
			eventType: 1,
		})
	})

	it('rejects non-CSI-u input', () => {
		expect(_testTuiKeys.parseKittyCsiUKey('a')).toBeNull()
		expect(_testTuiKeys.parseKittyCsiUKey('\x1b[A')).toBeNull()
		expect(_testTuiKeys.parseKittyCsiUKey('\x1b[foo u')).toBeNull()
	})
})

describe('Kitty functional key normalization regressions', () => {
	it('strips kitty event type and default modifiers for functional keys', () => {
		expect(_testTuiKeys.normalizeKittyFunctionalKey('\x1b[1;1:2A')).toBe('\x1b[A')
		expect(_testTuiKeys.normalizeKittyFunctionalKey('\x1b[1;3:2D')).toBe('\x1b[1;3D')
		expect(_testTuiKeys.normalizeKittyFunctionalKey('\x1b[1;2:1B')).toBe('\x1b[1;2B')
	})

	it('suppresses functional key release events', () => {
		expect(_testTuiKeys.normalizeKittyFunctionalKey('\x1b[1;2:3B')).toBeNull()
	})
})

describe('tui Kitty/Ghostty key interpretation (Ghostty fixture baseline)', () => {
	it('normalizes printable keys and suppresses release events', () => {
		expect(normalizeFixtureStep('a')).toEqual(['a'])
		expect(normalizeFixtureStep('space')).toEqual([' '])
		expect(normalizeFixtureStep('enter')).toEqual(['\r'])
		expect(normalizeFixtureStep('tab')).toEqual(['\t'])
	})

	it('preserves Shift-Enter and Shift-Tab as CSI-u while suppressing modifier key noise', () => {
		expect(normalizeFixtureStep('shift_enter')).toEqual(['\x1b[13;2u'])
		expect(normalizeFixtureStep('shift_tab')).toEqual(['\x1b[9;2u'])
	})

	it('normalizes enhanced arrow keys back to legacy/modified CSI sequences', () => {
		expect(normalizeFixtureStep('up')).toEqual(['\x1b[A'])
		expect(normalizeFixtureStep('left')).toEqual(['\x1b[D'])
		expect(normalizeFixtureStep('shift_down')).toEqual(['\x1b[1;2B'])
	})

	it('preserves Option word-motion as ESC-prefixed chars', () => {
		expect(normalizeFixtureStep('alt_left')).toEqual(['\x1bb'])
		expect(normalizeFixtureStep('alt_right')).toEqual(['\x1bf'])
	})

	it('normalizes Ctrl combos to control bytes', () => {
		expect(normalizeFixtureStep('ctrl_a')).toEqual(['\x01'])
		expect(normalizeFixtureStep('ctrl_w')).toEqual(['\x17'])
		expect(normalizeFixtureStep('ctrl_z')).toEqual(['\x1a'])
	})

	it('keeps Cmd+letter CSI-u payloads when the terminal sends them', () => {
		expect(normalizeFixtureStep('cmd_x')).toEqual(['\x1b[120;9u'])
	})

	it('shows Ghostty Cmd-A / Cmd-Z / empty Cmd-V as no normalized key token in this fixture', () => {
		expect(normalizeFixtureStep('cmd_a')).toEqual([])
		expect(normalizeFixtureStep('cmd_z')).toEqual([])
		expect(normalizeFixtureStep('cmd_v_empty')).toEqual([])
	})

	it('treats Ghostty Cmd-V with known clipboard content as pasted text', () => {
		const normalized = normalizeFixtureStep('cmd_v_known')
		expect(normalized.join('')).toBe(KNOWN_CMD_V_CLIPBOARD)
	})

	it.todo('handle Cmd-Z semantics when a terminal forwards Cmd-Z as a key event (not only Super press/release)')
	it.todo('handle Cmd-V shortcut semantics when a terminal forwards Cmd-V as a key event instead of paste text')
})
