// Arrakis: parchment, spice gold and shaded sandstone.
import { palette, themePlugin } from '../src/common/theme-palette.ts'
export const look = palette({
	screen: [0.13, 0.015, 70],
	user: [
		[0.84, 0.08, 80],
		[0.23, 0.025, 65],
	],
	reply: [0.83, 0.025, 85],
	accent: [0.8, 0.1, 65],
	read: [0.77, 0.07, 155],
	edit: [0.77, 0.08, 265],
	bash: [0.78, 0.09, 325],
})
export default themePlugin(look)
