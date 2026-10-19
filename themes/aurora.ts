// Aurora: arctic rose, green curtains and midnight violet.
import { palette, themePlugin } from '../src/client/theme-palette.ts'
export const look = palette({
	screen: [0.13, 0.015, 300],
	user: [
		[0.8, 0.08, 350],
		[0.22, 0.03, 345],
	],
	reply: [0.83, 0.025, 85],
	accent: [0.8, 0.09, 155],
	read: [0.79, 0.065, 190],
	edit: [0.77, 0.075, 265],
	bash: [0.78, 0.08, 310],
})
export default themePlugin(look)
