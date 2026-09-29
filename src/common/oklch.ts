// OKLCH to sRGB. A colour is [lightness 0..1, chroma, hue in degrees];
// equal L and C across hues look equally bright and vivid. Colours
// outside sRGB keep their lightness and hue and lose chroma until they
// fit.

export type Oklch = [number, number, number]

// Linear sRGB, unclamped.
function linear([L, C, h]: Oklch): [number, number, number] {
	let a = C * Math.cos((h * Math.PI) / 180)
	let b = C * Math.sin((h * Math.PI) / 180)
	let l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
	let m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
	let s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	]
}

const fits = (rgb: number[]) => rgb.every((x) => x >= -1e-4 && x <= 1 + 1e-4)

function gamma(x: number): number {
	x = Math.min(1, Math.max(0, x))
	return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055))
}

// Every frame paints the same few colours: each is converted once. The
// cache is dropped when full, so animated colours cannot grow it.
function toRgb(c: Oklch): [number, number, number] {
	let st = oklch.state
	let key = c.join()
	let rgb = st.rgb.get(key)
	if (st.rgb.size >= 4096) st.rgb.clear()
	if (!rgb) st.rgb.set(key, (rgb = oklch.convert(c)))
	return [...rgb]
}

function convert([L, C, h]: Oklch): [number, number, number] {
	L = Math.min(1, Math.max(0, L))
	let rgb = linear([L, C, h])
	if (!fits(rgb)) {
		let lo = 0
		let hi = C
		for (let i = 0; i < 20; i++) {
			let mid = (lo + hi) / 2
			if (fits(linear([L, mid, h]))) lo = mid
			else hi = mid
		}
		rgb = linear([L, lo, h])
	}
	return rgb.map(gamma) as [number, number, number]
}

function toHex(c: Oklch): string {
	return '#' + oklch.toRgb(c).map((x) => x.toString(16).padStart(2, '0')).join('')
}

// WCAG 2.2 contrast ratio of two colours as shown (after gamut
// mapping): 1 to 21, symmetric.
function contrast(a: Oklch, b: Oklch): number {
	let lum = (c: Oklch) => {
		let [r, g, bl] = oklch.toRgb(c).map((x) => {
			x /= 255
			return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
		})
		return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!
	}
	let [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
	return (hi! + 0.05) / (lo! + 0.05)
}

// A quieter `fg` for secondary text on `bg` (hints, ids, glimpses):
// darker by a lightness step, but never below 4.6:1 on `bg`, so it stays
// readable (tasks/README.md, readable text). We compute it; the
// terminal's faint style is never used.
function quiet(fg: Oklch, bg: Oklch): Oklch {
	let key = `${fg.join()}/${bg.join()}`
	let hit = oklch.state.quiet.get(key)
	if (hit) return hit
	if (oklch.state.quiet.size >= 256) oklch.state.quiet.clear()
	let out = search(fg, bg)
	oklch.state.quiet.set(key, out)
	return out
}

function search(fg: Oklch, bg: Oklch, target = 4.6, step = 0.12): Oklch {
	let [L, C, h] = fg
	let lo = Math.max(bg[0], L - step)
	if (oklch.contrast([lo, C, h], bg) >= target) return [lo, C, h]
	let hi = L
	for (let i = 0; i < 20; i++) {
		let mid = (lo + hi) / 2
		if (oklch.contrast([mid, C, h], bg) >= target) hi = mid
		else lo = mid
	}
	return [hi, C, h]
}

// The example request in an empty prompt: greyer and far darker than
// `fg`, about 2.2:1 on `bg`, so it never reads as typed text. The one
// exception to the readable-text rule (tasks/README.md): it says
// nothing the user needs and is gone at the first key.
function faint(fg: Oklch, bg: Oklch): Oklch {
	return search([fg[0], fg[1] / 2, fg[2]], bg, 2.2, 1)
}

export const oklch = { state: { rgb: new Map<string, [number, number, number]>(), quiet: new Map<string, Oklch>() }, toRgb, convert, toHex, contrast, quiet, faint }
