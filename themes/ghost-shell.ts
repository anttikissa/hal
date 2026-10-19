// Ghost Shell: jade interfaces, city darkness and pale violet signals.
import { palette, themePlugin } from '../src/common/theme-palette.ts'
export const look = palette({
	screen: [0.12, 0.012, 160],
	user: [
		[0.8, 0.1, 150],
		[0.21, 0.03, 150],
	],
	reply: [0.82, 0.035, 85],
	accent: [0.8, 0.07, 295],
	read: [0.8, 0.06, 195],
	edit: [0.77, 0.075, 265],
	bash: [0.77, 0.09, 330],
})
export default themePlugin(look)
