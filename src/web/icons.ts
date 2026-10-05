// Inline SVG icons for the web client (task 19m): Phosphor Regular on a
// 256 grid, except steer (Tabler arrow-ramp-right) and python (Tabler
// brand-python) on a 24 grid. Shapes
// with class "s" are strokes, the rest fill; index.html sets one stroke
// width for all grids. Regenerate from the upstream SVGs, never by hand.
//
// Phosphor Icons: MIT License, Copyright (c) 2023 Phosphor Icons.
// Tabler Icons: MIT License, Copyright (c) 2020-2026 Paweł Kuna.
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions: The above copyright notice and this
// permission notice shall be included in all copies or substantial
// portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
// WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
// THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
// LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

const phosphor = {
	attach: '<path d="M160,80,76.69,164.69a16,16,0,0,0,22.63,22.62L198.63,86.63a32,32,0,0,0-45.26-45.26L54.06,142.06a48,48,0,0,0,67.88,67.88L204,128" class="s"/>',
	pause: '<rect x="152" y="40" width="56" height="176" rx="8" class="s"/><rect x="48" y="40" width="56" height="176" rx="8" class="s"/>',
	play: '<path d="M72,39.88V216.12a8,8,0,0,0,12.15,6.69l144.08-88.12a7.82,7.82,0,0,0,0-13.38L84.15,33.19A8,8,0,0,0,72,39.88Z" class="s"/>',
	queue: '<line x1="40" y1="64" x2="216" y2="64" class="s"/><line x1="40" y1="128" x2="136" y2="128" class="s"/><line x1="40" y1="192" x2="136" y2="192" class="s"/><polygon points="240 160 176 200 176 120 240 160" class="s"/>',
	send: '<line x1="144" y1="128" x2="80" y2="128" class="s"/><path d="M48.49,221.28A8,8,0,0,0,59.93,231l168-96.09a8,8,0,0,0,0-14l-168-95.85a8,8,0,0,0-11.44,9.67L80,128Z" class="s"/>',
	run: '<polygon points="160 16 144 96 208 120 96 240 112 160 48 136 160 16" class="s"/>',
	close: '<line x1="200" y1="56" x2="56" y2="200" class="s"/><line x1="200" y1="200" x2="56" y2="56" class="s"/>',
	edit: '<path d="M92.69,216H48a8,8,0,0,1-8-8V163.31a8,8,0,0,1,2.34-5.65L165.66,34.34a8,8,0,0,1,11.31,0L221.66,79a8,8,0,0,1,0,11.31L98.34,213.66A8,8,0,0,1,92.69,216Z" class="s"/><line x1="136" y1="64" x2="192" y2="120" class="s"/>',
	undo: '<polyline points="24 56 24 104 72 104" class="s"/><path d="M67.59,192A88,88,0,1,0,65.77,65.77L24,104" class="s"/>',
	stop: '<rect x="48" y="48" width="160" height="160" rx="8" class="s"/>',
	more: '<polyline points="208 96 128 176 48 96" class="s"/>',
	less: '<polyline points="48 160 128 80 208 160" class="s"/>',
	menu: '<line x1="40" y1="128" x2="216" y2="128" class="s"/><line x1="40" y1="64" x2="216" y2="64" class="s"/><line x1="40" y1="192" x2="216" y2="192" class="s"/>',
	plus: '<line x1="40" y1="128" x2="216" y2="128" class="s"/><line x1="128" y1="40" x2="128" y2="216" class="s"/>',
	bell: '<path d="M96,192a32,32,0,0,0,64,0" class="s"/><path d="M56,104a72,72,0,0,1,144,0c0,35.82,8.3,64.6,14.9,76A8,8,0,0,1,208,192H48a8,8,0,0,1-6.88-12C47.71,168.6,56,139.81,56,104Z" class="s"/>',
	reload: '<polyline points="184 104 232 104 232 56" class="s"/><path d="M188.4,192a88,88,0,1,1,1.83-126.23L232,104" class="s"/>',
	logout: '<polyline points="112 40 48 40 48 216 112 216" class="s"/><line x1="112" y1="128" x2="224" y2="128" class="s"/><polyline points="184 88 224 128 184 168" class="s"/>',
	bug: '<circle cx="156" cy="92" r="12"/><circle cx="100" cy="92" r="12"/><line x1="128" y1="128" x2="128" y2="224" class="s"/><path d="M208,144a80,80,0,0,1-160,0V112a80,80,0,0,1,160,0Z" class="s"/><line x1="232" y1="184" x2="203.18" y2="171.41" class="s"/><line x1="232" y1="72" x2="203.18" y2="84.59" class="s"/><line x1="24" y1="72" x2="52.82" y2="84.59" class="s"/><line x1="24" y1="184" x2="52.82" y2="171.41" class="s"/><line x1="16" y1="128" x2="240" y2="128" class="s"/>',
	bash: '<polyline points="80 96 120 128 80 160" class="s"/><line x1="136" y1="160" x2="176" y2="160" class="s"/><rect x="32" y="48" width="192" height="160" rx="8" class="s"/>',
	read: '<path d="M200,224H56a8,8,0,0,1-8-8V40a8,8,0,0,1,8-8h96l56,56V216A8,8,0,0,1,200,224Z" class="s"/><polyline points="152 32 152 88 208 88" class="s"/><line x1="96" y1="136" x2="160" y2="136" class="s"/><line x1="96" y1="168" x2="160" y2="168" class="s"/>',
	web: '<circle cx="128" cy="128" r="96" class="s"/><path d="M168,128c0,64-40,96-40,96s-40-32-40-96,40-96,40-96S168,64,168,128Z" class="s"/><line x1="37.46" y1="96" x2="218.54" y2="96" class="s"/><line x1="37.46" y1="160" x2="218.54" y2="160" class="s"/>',
	google: '<circle cx="112" cy="112" r="80" class="s"/><line x1="168.57" y1="168.57" x2="224" y2="224" class="s"/>',
	message: '<line x1="96" y1="112" x2="160" y2="112" class="s"/><line x1="96" y1="144" x2="160" y2="144" class="s"/><path d="M79.93,211.11a96,96,0,1,0-35-35h0L32.42,213.46a8,8,0,0,0,10.12,10.12l37.39-12.47Z" class="s"/>',
	spawn: '<path d="M64,88v24a16,16,0,0,0,16,16h96a16,16,0,0,0,16-16V88" class="s"/><line x1="128" y1="128" x2="128" y2="168" class="s"/><circle cx="64" cy="64" r="24" class="s"/><circle cx="128" cy="192" r="24" class="s"/><circle cx="192" cy="64" r="24" class="s"/>',
	wait: '<path d="M128,128,67.2,82.4A8,8,0,0,1,64,76V40a8,8,0,0,1,8-8H184a8,8,0,0,1,8,8V75.64A8,8,0,0,1,188.82,82L128,128h0" class="s"/><path d="M128,128,67.2,173.6A8,8,0,0,0,64,180v36a8,8,0,0,0,8,8H184a8,8,0,0,0,8-8V180.36a8,8,0,0,0-3.18-6.38L128,128h0" class="s"/><line x1="128" y1="168" x2="128" y2="128" class="s"/><line x1="74.67" y1="88" x2="180.92" y2="88" class="s"/>',
	command: '<polygon points="160 16 144 96 208 120 96 240 112 160 48 136 160 16" class="s"/>',
	inspect: '<circle cx="128" cy="128" r="96" class="s"/><path d="M120,120a8,8,0,0,1,8,8v40a8,8,0,0,0,8,8" class="s"/><circle cx="124" cy="84" r="12"/>',
	notify: '<path d="M96,192a32,32,0,0,0,64,0" class="s"/><path d="M184,24a102.71,102.71,0,0,1,36.29,40" class="s"/><path d="M35.71,64A102.71,102.71,0,0,1,72,24" class="s"/><path d="M56,112a72,72,0,0,1,144,0c0,35.82,8.3,56.6,14.9,68A8,8,0,0,1,208,192H48a8,8,0,0,1-6.88-12C47.71,168.6,56,147.81,56,112Z" class="s"/>',
	ask: '<circle cx="128" cy="180" r="12"/><path d="M128,144v-8c17.67,0,32-12.54,32-28s-14.33-28-32-28S96,92.54,96,108v4" class="s"/><circle cx="128" cy="128" r="96" class="s"/>',
	blob: '<polygon points="152 224 104 152 76.36 193.46 60 168 24 224 152 224" class="s"/><polyline points="152 32 152 88 208 88" class="s"/><path d="M192,224h8a8,8,0,0,0,8-8V88L152,32H56a8,8,0,0,0-8,8v88" class="s"/>',
	check: '<polyline points="40 144 96 200 224 72" class="s"/>',
	copy: '<polyline points="168 168 216 168 216 40 88 40 88 88" class="s"/><rect x="40" y="88" width="128" height="128" class="s"/>',
	download: '<line x1="128" y1="144" x2="128" y2="32" class="s"/><polyline points="216 144 216 208 40 208 40 144" class="s"/><polyline points="168 104 128 144 88 104" class="s"/>',
	image: '<rect x="32" y="48" width="192" height="160" rx="8" class="s"/><circle cx="156" cy="100" r="12"/><path d="M147.31,164,173,138.34a8,8,0,0,1,11.31,0L224,178.06" class="s"/><path d="M32,168.69l54.34-54.35a8,8,0,0,1,11.32,0L191.31,208" class="s"/>',
	thinking: '<line x1="88" y1="32" x2="168" y2="32" class="s"/><path d="M152,32V99.14l62.85,104.74A8,8,0,0,1,208,216H48a8,8,0,0,1-6.86-12.12L104,99.14V32" class="s"/><path d="M71.63,153.08c13.23-2.48,32-1.41,56.37,10.92,32.25,16.33,54.75,12.91,67.5,7.65" class="s"/>',
}

const grid24 = {
	steer: '<path class="s" d="M7 3l0 8.707"/><path class="s" d="M11 7l-4 -4l-4 4"/><path class="s" d="M17 14l4 -4l-4 -4"/><path class="s" d="M7 21a11 11 0 0 1 11 -11h3"/>',
	python: '<path class="s" d="M12 9h-7a2 2 0 0 0 -2 2v4a2 2 0 0 0 2 2h3"/><path class="s" d="M12 15h7a2 2 0 0 0 2 -2v-4a2 2 0 0 0 -2 -2h-3"/><path class="s" d="M8 9v-4a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v5a2 2 0 0 1 -2 2h-4a2 2 0 0 0 -2 2v5a2 2 0 0 0 2 2h4a2 2 0 0 0 2 -2v-4"/><path class="s" d="M11 6l0 .01"/><path class="s" d="M13 18l0 .01"/>',
}

export type IconName = keyof typeof phosphor | keyof typeof grid24

export const icons = {
	/** An icon's inner SVG markup and the grid it is drawn on. */
	svg(name: IconName): { body: string; grid: 24 | 256 } {
		return name in grid24 ? { body: grid24[name as keyof typeof grid24], grid: 24 } : { body: phosphor[name as keyof typeof phosphor], grid: 256 }
	},
}
