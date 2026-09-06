// Client-local reveal state, never persisted into the user's opacity settings.
// Blend the already-resolved theme RGB values; no extra color-space conversion.
import { terminalBackground } from './terminal-background.ts'
import { cursor } from './cursor.ts'
import { colors } from './colors.ts'
import { termCaps } from '../../utils/term-caps.ts'
import { visLen } from '../../utils/strings.ts'

const state = {
	sections: new Map<string, { visible: boolean; start: number | null }>(),
}

function reset(): void {
	state.sections.clear()
}

function isFading(key: string): boolean {
	return state.sections.get(key)?.start != null
}

function active(): boolean {
	for (const section of state.sections.values()) {
		if (section.start !== null) return true
	}
	return false
}

function blend(line: string, alpha: number): string {
	const background = terminalBackground.state.background
	if (!background || alpha >= 1) return line
	if (alpha <= 0) return ' '.repeat(visLen(line))
	// Restore a section's base foreground after SGR reset, so unstyled suffixes
	// cannot flash at full brightness. Default backgrounds already match OSC 11.
	const base = line.match(/\x1b\[38;2;\d+;\d+;\d+m/)?.[0] || colors.status.fg
	const styled = base + line.replace(/\x1b\[(?:0|39)?m/g, (reset) => reset + base)
	return styled.replace(/\x1b\[(38|48);2;(\d+);(\d+);(\d+)m/g, (_match, mode, r, g, b) => {
		const red = Math.round(background[0] + (Number(r) - background[0]) * alpha)
		const green = Math.round(background[1] + (Number(g) - background[1]) * alpha)
		const blue = Math.round(background[2] + (Number(b) - background[2]) * alpha)
		return `\x1b[${mode};2;${red};${green};${blue}m`
	}) + '\x1b[0m'
}

function apply(lines: string[], start: number, key: string, target: number): void {
	const visible = target > 0
	let section = state.sections.get(key)
	if (!section) {
		// An already-configured UI starts normally. Only an observed 0 → 1 fades.
		state.sections.set(key, { visible, start: null })
		return
	}
	const tick = cursor.heartbeatTick()
	if (!visible || !terminalBackground.state.background || !termCaps.config.truecolor) section.start = null
	else if (!section.visible) section.start = tick
	section.visible = visible
	if (section.start === null) return
	const alpha = Math.min(1, Math.max(0, (tick - section.start) / 12))
	if (alpha === 1) section.start = null
	for (let i = start; i < lines.length; i++) lines[i] = chromeFade.blend(lines[i]!, alpha)
}

export const chromeFade = { state, reset, active, isFading, blend, apply }
