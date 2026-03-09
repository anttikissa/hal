// Centralized color definitions for the TUI.

const RESET = '\x1b[0m'
const DIM = '\x1b[38;5;245m'
const SEL_ON = '\x1b[7m'   // reverse video
const SEL_OFF = '\x1b[27m'

// ── OKLCH color system ──

function oklch(L: number, C: number, H: number): [number, number, number] {
	const hRad = H * Math.PI / 180
	const a = C * Math.cos(hRad), b = C * Math.sin(hRad)
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b
	const s_ = L - 0.0894841775 * a - 1.2914855480 * b
	const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
	const rl = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
	const gl = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
	const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
	const toSrgb = (c: number) => Math.round(255 * Math.max(0, Math.min(1,
		c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)))
	return [toSrgb(rl), toSrgb(gl), toSrgb(bl)]
}

function fg([r, g, b]: [number, number, number]): string { return `\x1b[38;2;${r};${g};${b}m` }
function bg([r, g, b]: [number, number, number]): string { return `\x1b[48;2;${r};${g};${b}m` }

// ── Block colors ──
// Tool colors: matched lightness in OKLCH
// Foreground (bright text): L=0.75, C=0.15
// Background (dark bg):     L=0.25, C=0.05

const assistant = { fg: fg(oklch(0.75, 0.15, 70)), bg: bg(oklch(0.25, 0.05, 70)) }
const input     = { fg: fg(oklch(0.80, 0.008, 250)), bg: bg(oklch(0.29, 0.008, 250)) }
const thinking  = { fg: fg(oklch(0.73, 0.03, 250)), bg: bg(oklch(0.28, 0.02, 250)) }
const info      = { fg: fg(oklch(0.74, 0.02, 250)), bg: bg(oklch(0.25, 0.02, 250)) }
const error     = { fg: fg(oklch(0.65, 0.20, 35)),  bg: bg(oklch(0.28, 0.08, 35)) }
const system    = { fg: fg(oklch(0.75, 0.15, 190)), bg: bg(oklch(0.25, 0.05, 190)) }
const cursor    = { fg: fg(oklch(0.75, 0.15, 70)) }

const tools: Record<string, { fg: string; bg: string }> = {
	bash:    { fg: fg(oklch(0.75, 0.15, 320)), bg: bg(oklch(0.25, 0.05, 320)) },
	read:    { fg: fg(oklch(0.75, 0.15, 145)), bg: bg(oklch(0.25, 0.05, 145)) },
	default: { fg: fg(oklch(0.75, 0.15, 260)), bg: bg(oklch(0.25, 0.05, 260)) },
}

function tool(name: string): { fg: string; bg: string } {
	return tools[name] ?? tools.default
}

export { RESET, DIM, SEL_ON, SEL_OFF, assistant, input, system, thinking, info, error, cursor, tool }
