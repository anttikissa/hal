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

function toRgb([L, C, h]: Oklch): [number, number, number] {
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

export const oklch = { toRgb, toHex }
