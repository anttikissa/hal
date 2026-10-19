// Fury Road: copper dust against the blue of a desert night.
import { palette, themePlugin } from '../src/common/theme-palette.ts'
export const look = palette({
	screen: [0.13, 0.018, 245],
	user: [
		[0.8, 0.095, 50],
		[0.22, 0.035, 45],
	],
	reply: [0.82, 0.045, 235],
	accent: [0.84, 0.11, 75],
	read: [0.79, 0.08, 170],
	edit: [0.76, 0.09, 260],
	bash: [0.78, 0.09, 325],
})
export default themePlugin(look)
