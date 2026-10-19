// Windows 95 after dark: cobalt selection, silver chrome, teal desktop.
import { palette, themePlugin } from '../src/common/theme-palette.ts'
export const look = palette({
	screen: [0.16, 0.02, 195],
	user: [
		[0.85, 0.045, 260],
		[0.24, 0.065, 265],
	],
	reply: [0.84, 0.005, 250],
	accent: [0.8, 0.06, 195],
	read: [0.78, 0.09, 150],
	edit: [0.78, 0.07, 285],
	bash: [0.78, 0.09, 325],
})
export default themePlugin(look)
