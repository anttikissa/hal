import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse as parseAson } from '../utils/ason.ts'
import { _testTuiKeys } from './tui.ts'
import { parseKeys } from './tui-text.ts'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
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

// ── Fixture loading ──

const FIXTURES_DIR = new URL('../tests/fixtures/keys/', import.meta.url)

const FIXTURE_FILES: Record<string, string> = {
	ghostty: 'keys-ghostty.ason',
	kitty: 'keys-xterm-kitty.ason',
	iterm: 'keys-iterm-app.ason',
	apple: 'keys-apple-terminal.ason',
}

function loadFixture(name: string): FixtureDoc {
	const raw = readFileSync(new URL(FIXTURE_FILES[name], FIXTURES_DIR), 'utf8')
	return parseAson(raw) as FixtureDoc
}

function getProfile(doc: FixtureDoc, id: string): FixtureProfile {
	const profile = doc.profiles?.find((p) => p.id === id)
	if (!profile) throw new Error(`Missing profile in fixture: ${id}`)
	return profile
}

function getStepMap(doc: FixtureDoc, profileId: string): Map<string, FixtureStep> {
	const prof = getProfile(doc, profileId)
	return new Map(prof.steps.map((s) => [s.stepId, s]))
}

function bytesToRaw(bytes: number[]): string {
	return Buffer.from(bytes).toString('utf8')
}

function textToHex(text: string): string {
	return [...Buffer.from(text)].map((b) => b.toString(16).padStart(2, '0')).join(' ')
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

function normalizeStep(step: FixtureStep): string[] {
	const raw = bytesToRaw(step.bytes)
	const tokens = parseKeys(raw, PASTE_START, PASTE_END)
	return normalizeTokens(tokens)
}

// ── Preload all fixtures ──

const fixtures = Object.fromEntries(
	Object.keys(FIXTURE_FILES).map((name) => {
		const doc = loadFixture(name)
		return [name, { doc, steps: getStepMap(doc, 'kitty11') }]
	}),
)

// Helper: get step from a specific fixture, skip if missing/not captured
function getCapturedStep(terminal: string, stepId: string): FixtureStep | null {
	const step = fixtures[terminal].steps.get(stepId)
	if (!step || step.status !== 'captured' || step.bytes.length === 0) return null
	return step
}

// ── Ghostty baseline (original tests) ──

describe('tui keyboard fixture baseline (Ghostty, kitty11)', () => {
	const ghosttyDoc = fixtures.ghostty.doc
	const ghosttyKitty11 = getProfile(ghosttyDoc, 'kitty11')

	it('loads the Ghostty fixture', () => {
		expect(ghosttyDoc.terminalLabel).toBe('ghostty')
		expect(ghosttyKitty11.id).toBe('kitty11')
		expect(ghosttyKitty11.steps.length).toBeGreaterThan(30)
	})

	it('replays parseKeys tokenization for all captured Ghostty steps', () => {
		for (const step of ghosttyKitty11.steps) {
			const parsed = parseKeys(bytesToRaw(step.bytes), PASTE_START, PASTE_END)
			const parsedHex = parsed.map(textToHex)
			const fixtureHex = (step.tokens ?? []).map((t) => t.hex)
			expect(parsedHex, step.stepId).toEqual(fixtureHex)
		}
	})
})

// ── CSI-u parsing unit tests ──

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

// ── Functional key normalization unit tests ──

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

// ── Modifier-only key suppression ──

describe('modifier-only keys are suppressed', () => {
	// PUA codepoints: Shift_L=57441 Shift_R=57442 Ctrl_L=57443 Alt_L=57445
	// rawModifier bits: Shift=1 Alt=2 Ctrl=4 Super=8 (add 1 for CSI u encoding)

	it('suppresses bare Shift press', () => {
		_testTuiKeys.resetState()
		expect(_testTuiKeys.normalizeKittyKey('\x1b[57441;2:1u')).toBeNull()
	})

	it('suppresses Shift release', () => {
		_testTuiKeys.resetState()
		expect(_testTuiKeys.normalizeKittyKey('\x1b[57441;2:3u')).toBeNull()
	})

	it('suppresses Cmd+Shift (Shift press while Super held)', () => {
		_testTuiKeys.resetState()
		// rawModifier = Shift(1) + Super(8) + 1 = 10
		expect(_testTuiKeys.normalizeKittyKey('\x1b[57441;10:1u')).toBeNull()
	})

	it('suppresses Ctrl+Shift (Shift press while Ctrl held)', () => {
		_testTuiKeys.resetState()
		// rawModifier = Shift(1) + Ctrl(4) + 1 = 6
		expect(_testTuiKeys.normalizeKittyKey('\x1b[57441;6:1u')).toBeNull()
	})

	it('suppresses Cmd+Ctrl+Shift (Shift press while Super+Ctrl held)', () => {
		_testTuiKeys.resetState()
		// rawModifier = Shift(1) + Ctrl(4) + Super(8) + 1 = 14
		expect(_testTuiKeys.normalizeKittyKey('\x1b[57441;14:1u')).toBeNull()
	})

	it('suppresses bare Alt/Option press', () => {
		_testTuiKeys.resetState()
		expect(_testTuiKeys.normalizeKittyKey('\x1b[57445;3:1u')).toBeNull()
	})

	it('suppresses bare Ctrl press', () => {
		_testTuiKeys.resetState()
		expect(_testTuiKeys.normalizeKittyKey('\x1b[57443;5:1u')).toBeNull()
	})

	it('does NOT suppress real keys with Super modifier (e.g. Cmd+A)', () => {
		_testTuiKeys.resetState()
		// codepoint 97 = 'a', rawModifier = Super(8) + 1 = 9
		const result = _testTuiKeys.normalizeKittyKey('\x1b[97;9u')
		expect(result).not.toBeNull()
	})
})

// ── Ghostty-specific normalization (original tests) ──

describe('tui Kitty/Ghostty key interpretation (Ghostty fixture baseline)', () => {
	function normalizeGhosttyStep(stepId: string): string[] {
		const step = fixtures.ghostty.steps.get(stepId)
		if (!step) throw new Error(`Missing Ghostty fixture step: ${stepId}`)
		return normalizeStep(step)
	}

	it('normalizes printable keys and suppresses release events', () => {
		expect(normalizeGhosttyStep('a')).toEqual(['a'])
		expect(normalizeGhosttyStep('space')).toEqual([' '])
		expect(normalizeGhosttyStep('enter')).toEqual(['\r'])
		expect(normalizeGhosttyStep('tab')).toEqual(['\t'])
	})

	it('preserves Shift-Enter and Shift-Tab as CSI-u while suppressing modifier key noise', () => {
		expect(normalizeGhosttyStep('shift_enter')).toEqual(['\x1b[13;2u'])
		expect(normalizeGhosttyStep('shift_tab')).toEqual(['\x1b[9;2u'])
	})

	it('normalizes enhanced arrow keys back to legacy/modified CSI sequences', () => {
		expect(normalizeGhosttyStep('up')).toEqual(['\x1b[A'])
		expect(normalizeGhosttyStep('left')).toEqual(['\x1b[D'])
		expect(normalizeGhosttyStep('shift_down')).toEqual(['\x1b[1;2B'])
	})

	it('preserves Option word-motion as ESC-prefixed chars', () => {
		expect(normalizeGhosttyStep('alt_left')).toEqual(['\x1bb'])
		expect(normalizeGhosttyStep('alt_right')).toEqual(['\x1bf'])
	})

	it('normalizes Ctrl combos to control bytes', () => {
		expect(normalizeGhosttyStep('ctrl_c')).toEqual(['\x03'])
		expect(normalizeGhosttyStep('ctrl_z')).toEqual(['\x1a'])
	})

	it('keeps Cmd+letter CSI-u payloads when the terminal sends them', () => {
		expect(normalizeGhosttyStep('cmd_x')).toEqual(['\x1b[120;9u'])
	})

	it('shows Ghostty Cmd-A / Cmd-Z / empty Cmd-V as no normalized key token in this fixture', () => {
		expect(normalizeGhosttyStep('cmd_a')).toEqual([])
		expect(normalizeGhosttyStep('cmd_z')).toEqual([])
		expect(normalizeGhosttyStep('cmd_v_empty')).toEqual([])
	})

	it('treats Ghostty Cmd-V with known clipboard content as pasted text', () => {
		const normalized = normalizeGhosttyStep('cmd_v_known')
		expect(normalized.join('')).toBe(KNOWN_CMD_V_CLIPBOARD)
	})

	it('handles Cmd-Z when terminal forwards it as a key event', () => {
		_testTuiKeys.resetState()
		// Kitty CSI-u: codepoint z (122), Super modifier (8) + 1.
		const normalized = _testTuiKeys.normalizeKittyKey('\x1b[122;9u')
		expect(normalized).toBe('\x1b[122;9u')
	})

	it('handles Cmd-V shortcut when terminal forwards it as a key event', () => {
		_testTuiKeys.resetState()
		// Kitty CSI-u: codepoint v (118), Super modifier (8) + 1.
		const normalized = _testTuiKeys.normalizeKittyKey('\x1b[118;9u')
		expect(normalized).toBe('\x1b[118;9u')
	})
})

// ── Cross-terminal parseKeys tokenization ──

describe('parseKeys tokenization (all terminals)', () => {
	for (const [name, { doc }] of Object.entries(fixtures)) {
		const profile = getProfile(doc, 'kitty11')

		it(`round-trips all captured ${name} steps through parseKeys`, () => {
			for (const step of profile.steps) {
				if (step.status !== 'captured' || step.bytes.length === 0) continue
				const parsed = parseKeys(bytesToRaw(step.bytes), PASTE_START, PASTE_END)
				const parsedHex = parsed.map(textToHex)
				const fixtureHex = (step.tokens ?? []).map((t) => t.hex)
				expect(parsedHex, `${name}/${step.stepId}`).toEqual(fixtureHex)
			}
		})
	}
})

// ── Cross-terminal normalization convergence ──
// Keys that should produce identical normalized output across all kitty-capable terminals.

describe('normalization convergence (kitty-capable terminals)', () => {
	const kittyTerminals = ['ghostty', 'kitty', 'iterm'] as const

	// stepId → expected normalized output
	const convergent: Record<string, string[]> = {
		a: ['a'],
		space: [' '],
		enter: ['\r'],
		tab: ['\t'],
		backspace: ['\x7f'],
		esc: ['\x1b'],
		delete: ['\x1b[3~'],
		up: ['\x1b[A'],
		down: ['\x1b[B'],
		left: ['\x1b[D'],
		right: ['\x1b[C'],
		shift_left: ['\x1b[1;2D'],
		shift_right: ['\x1b[1;2C'],
		shift_up: ['\x1b[1;2A'],
		shift_down: ['\x1b[1;2B'],
		shift_enter: ['\x1b[13;2u'],
		shift_tab: ['\x1b[9;2u'],
		ctrl_c: ['\x03'],
		ctrl_z: ['\x1a'],
		alt_1: ['\x1b1'],
	}

	for (const [stepId, expected] of Object.entries(convergent)) {
		it(`${stepId} normalizes identically across Ghostty/Kitty/iTerm`, () => {
			for (const terminal of kittyTerminals) {
				const step = getCapturedStep(terminal, stepId)
				if (!step) continue
				expect(normalizeStep(step), `${terminal}/${stepId}`).toEqual(expected)
			}
		})
	}

	it('Cmd-V with known clipboard yields paste text on all kitty-capable terminals', () => {
		for (const terminal of kittyTerminals) {
			const step = getCapturedStep(terminal, 'cmd_v_known')
			if (!step) continue
			const normalized = normalizeStep(step)
			expect(normalized.join(''), `${terminal}/cmd_v_known`).toBe(KNOWN_CMD_V_CLIPBOARD)
		}
	})
})

// ── Apple Terminal (legacy-only) ──

describe('Apple Terminal legacy key handling', () => {
	function normalizeAppleStep(stepId: string): string[] | null {
		const step = getCapturedStep('apple', stepId)
		if (!step) return null
		return normalizeStep(step)
	}

	it('passes through basic keys unchanged', () => {
		expect(normalizeAppleStep('a')).toEqual(['a'])
		expect(normalizeAppleStep('space')).toEqual([' '])
		expect(normalizeAppleStep('enter')).toEqual(['\r'])
		expect(normalizeAppleStep('tab')).toEqual(['\t'])
		expect(normalizeAppleStep('backspace')).toEqual(['\x7f'])
	})

	it('passes through legacy arrow keys', () => {
		expect(normalizeAppleStep('up')).toEqual(['\x1b[A'])
		expect(normalizeAppleStep('down')).toEqual(['\x1b[B'])
		expect(normalizeAppleStep('left')).toEqual(['\x1b[D'])
		expect(normalizeAppleStep('right')).toEqual(['\x1b[C'])
	})

	it('handles Shift-A as uppercase (no kitty protocol)', () => {
		expect(normalizeAppleStep('A')).toEqual(['A'])
	})

	it('does not distinguish Shift+arrow from plain arrow', () => {
		// Apple Terminal ignores shift modifier for arrows
		expect(normalizeAppleStep('shift_up')).toEqual(['\x1b[A'])
		expect(normalizeAppleStep('shift_down')).toEqual(['\x1b[B'])
	})

	it('sends Shift+arrow as modified CSI for left/right', () => {
		expect(normalizeAppleStep('shift_left')).toEqual(['\x1b[1;2D'])
		expect(normalizeAppleStep('shift_right')).toEqual(['\x1b[1;2C'])
	})

	it('sends legacy Shift-Tab as ESC[Z', () => {
		expect(normalizeAppleStep('shift_tab')).toEqual(['\x1b[Z'])
	})

	it('sends Option word-motion as ESC-prefixed chars', () => {
		expect(normalizeAppleStep('alt_left')).toEqual(['\x1bb'])
		expect(normalizeAppleStep('alt_right')).toEqual(['\x1bf'])
	})

	it('sends Ctrl combos as legacy control bytes', () => {
		expect(normalizeAppleStep('ctrl_c')).toEqual(['\x03'])
		expect(normalizeAppleStep('ctrl_z')).toEqual(['\x1a'])
	})

	it('delivers Cmd-V clipboard as pasted text (OS-level paste)', () => {
		const step = getCapturedStep('apple', 'cmd_v_known')
		if (!step) return
		const normalized = normalizeStep(step)
		expect(normalized.join('')).toBe(KNOWN_CMD_V_CLIPBOARD)
	})
})

// ── Known terminal-specific divergences ──

describe('known terminal-specific divergences', () => {
	it('Shift-A: kitty-capable terminals normalize to lowercase a; Apple sends uppercase A', () => {
		for (const t of ['ghostty', 'kitty', 'iterm'] as const) {
			const step = getCapturedStep(t, 'A')
			if (!step) continue
			expect(normalizeStep(step), t).toEqual(['a'])
		}
		const apple = getCapturedStep('apple', 'A')
		if (apple) expect(normalizeStep(apple)).toEqual(['A'])
	})

	it('Alt+Left: Ghostty/Apple → ESCb, Kitty → ESC[1;3D, iTerm → mis-tokenized', () => {
		const ghostty = getCapturedStep('ghostty', 'alt_left')
		if (ghostty) expect(normalizeStep(ghostty)).toEqual(['\x1bb'])

		const apple = getCapturedStep('apple', 'alt_left')
		if (apple) expect(normalizeStep(apple)).toEqual(['\x1bb'])

		// Kitty sends standard CSI Alt+Left instead of ESCb
		const kitty = getCapturedStep('kitty', 'alt_left')
		if (kitty) expect(normalizeStep(kitty)).toEqual(['\x1b[1;3D'])

		// iTerm sends ESC ESC[D which gets mis-tokenized
		const iterm = getCapturedStep('iterm', 'alt_left')
		if (iterm) {
			const normalized = normalizeStep(iterm)
			// Documents current (broken) behavior: ESC-ESC pair + orphaned [ and D
			expect(normalized.length).toBeGreaterThan(1)
		}
	})

	it('Alt+Right: Ghostty/Apple → ESCf, Kitty → ESC[1;3C, iTerm → mis-tokenized', () => {
		const ghostty = getCapturedStep('ghostty', 'alt_right')
		if (ghostty) expect(normalizeStep(ghostty)).toEqual(['\x1bf'])

		const apple = getCapturedStep('apple', 'alt_right')
		if (apple) expect(normalizeStep(apple)).toEqual(['\x1bf'])

		const kitty = getCapturedStep('kitty', 'alt_right')
		if (kitty) expect(normalizeStep(kitty)).toEqual(['\x1b[1;3C'])

		const iterm = getCapturedStep('iterm', 'alt_right')
		if (iterm) {
			const normalized = normalizeStep(iterm)
			expect(normalized.length).toBeGreaterThan(1)
		}
	})

	it('Cmd-A: Ghostty suppresses, Kitty sends CSI-u, iTerm/Apple → empty (OS intercept)', () => {
		const ghostty = getCapturedStep('ghostty', 'cmd_a')
		if (ghostty) expect(normalizeStep(ghostty)).toEqual([])

		const kitty = getCapturedStep('kitty', 'cmd_a')
		if (kitty) expect(normalizeStep(kitty)).toEqual(['\x1b[97;9u'])
	})

	it('Cmd-Z: Ghostty suppresses, Kitty sends CSI-u, iTerm/Apple → empty (OS intercept)', () => {
		const ghostty = getCapturedStep('ghostty', 'cmd_z')
		if (ghostty) expect(normalizeStep(ghostty)).toEqual([])

		const kitty = getCapturedStep('kitty', 'cmd_z')
		if (kitty) expect(normalizeStep(kitty)).toEqual(['\x1b[122;9u'])
	})
})
