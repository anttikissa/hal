/// <reference lib="dom" />
// One inline SVG icon, sized by CSS (.icon in index.html). Decorative:
// the button or label around it carries the accessible name.
import { icons, type IconName } from '../icons.ts'

export function Icon(props: { name: IconName }) {
	let svg = () => icons.svg(props.name)
	return <svg class={['icon', `g${svg().grid}`]} viewBox={`0 0 ${svg().grid} ${svg().grid}`} aria-hidden="true" innerHTML={svg().body} />
}
