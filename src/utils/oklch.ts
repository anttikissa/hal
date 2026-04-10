// OKLCH → sRGB conversion.
//
// OKLCH is a perceptual color space:
//   L = lightness (0–1), C = chroma (0–~0.4), H = hue (0–360°)
//
// Same chroma+lightness across different hues produces colors that
// LOOK equally vivid and equally bright — unlike HSL where "same S/L"
// gives wildly different perceptual brightness per hue.
//
// The math: OKLCH → OKLab → linear sRGB → gamma-corrected sRGB.

function oklchToRgb(L: number, C: number, H: number): [number, number, number] {
	// OKLCH → OKLab (polar → cartesian)
	const hRad = (H * Math.PI) / 180
	const a = C * Math.cos(hRad)
	const b = C * Math.sin(hRad)

	// OKLab → approximate linear sRGB via the LMS intermediate.
	// These matrices are from Björn Ottosson's original OKLab paper.
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b
	const s_ = L - 0.0894841775 * a - 1.291485548 * b
	const l = l_ ** 3,
		m = m_ ** 3,
		s = s_ ** 3

	// LMS → linear sRGB
	const rl = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
	const gl = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
	const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s

	// Linear sRGB → gamma-corrected sRGB (standard sRGB transfer function)
	const gamma = (c: number) =>
		Math.round(255 * Math.max(0, Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)))
	return [gamma(rl), gamma(gl), gamma(bl)]
}

// ANSI true-color escape: foreground
function toFg(L: number, C: number, H: number): string {
	const [r, g, b] = oklchToRgb(L, C, H)
	return `\x1b[38;2;${r};${g};${b}m`
}

// ANSI true-color escape: background
function toBg(L: number, C: number, H: number): string {
	const [r, g, b] = oklchToRgb(L, C, H)
	return `\x1b[48;2;${r};${g};${b}m`
}

// Dim all truecolor ANSI escapes in a string by scaling RGB values.
// factor < 1 darkens, > 1 brightens. Works on both fg (38;2) and bg (48;2).
const TRUECOLOR_RE = /\x1b\[(38|48);2;(\d+);(\d+);(\d+)m/g
function dimAnsi(line: string, factor = 0.5): string {
	return line.replace(TRUECOLOR_RE, (_, mode, r, g, b) => {
		const scale = (v: string) => Math.round(Math.min(255, Number(v) * factor))
		return `\x1b[${mode};2;${scale(r)};${scale(g)};${scale(b)}m`
	})
}

function clamp01(n: number): number {
	return Math.max(0, Math.min(1, n))
}

// Green → yellow → orange → red, with slightly increasing chroma as usage rises.
function usageFg(usedPercent: number): string {
	const t = clamp01(usedPercent / 100)
	const L = 0.78
	const C = 0.04 + t * 0.12
	const H = 145 - t * 120
	return toFg(L, C, H)
}

export const oklch = { oklchToRgb, toFg, toBg, dimAnsi, usageFg }
