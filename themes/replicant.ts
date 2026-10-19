// Replicant: rain-lit lavender and rose neon on ink.
import { palette, themePlugin } from '../src/client/theme-palette.ts'
export const look = palette({
	screen: [0.12, 0.018, 285],
	user: [
		[0.8, 0.075, 295],
		[0.22, 0.035, 295],
	],
	reply: [0.82, 0.07, 75],
	accent: [0.8, 0.1, 345],
	read: [0.79, 0.09, 160],
	edit: [0.76, 0.08, 255],
	bash: [0.78, 0.09, 325],
})
export default themePlugin(look)
