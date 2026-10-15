// Atlantis: luminous sea glass and submerged blue stone.
import { palette, themePlugin } from '../src/common/theme-palette.ts'
export const look = palette({ screen: [0.13, 0.018, 215], user: [[0.81, 0.07, 185], [0.22, 0.025, 190]], reply: [0.83, 0.045, 80], accent: [0.79, 0.075, 230], read: [0.78, 0.09, 150], edit: [0.77, 0.08, 275], bash: [0.77, 0.09, 325] })
export default themePlugin(look)
