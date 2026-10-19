// Moonbase: frost-blue readouts on the dark side of the moon.
import { palette, themePlugin } from '../src/common/theme-palette.ts'
export const look = palette({
	screen: [0.12, 0.014, 265],
	user: [
		[0.79, 0.075, 255],
		[0.21, 0.035, 255],
	],
	reply: [0.84, 0.015, 250],
	accent: [0.8, 0.06, 195],
	read: [0.79, 0.08, 155],
	edit: [0.78, 0.07, 290],
	bash: [0.78, 0.09, 330],
})
export default themePlugin(look)
