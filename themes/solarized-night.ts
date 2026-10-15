// Solarized Night: blue-black ink, muted cyan and warm paper light.
import { palette, themePlugin } from '../src/common/theme-palette.ts'
export const look = palette({ screen: [0.16, 0.025, 220], user: [[0.76, 0.07, 225], [0.22, 0.025, 225]], reply: [0.82, 0.035, 90], accent: [0.8, 0.085, 85], read: [0.78, 0.075, 145], edit: [0.77, 0.07, 275], bash: [0.77, 0.08, 330] })
export default themePlugin(look)
