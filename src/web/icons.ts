// Inline SVG icons for the web client (task 19m): Phosphor Regular on a
// 256 grid, except steer (Tabler arrow-ramp-right) on a 24 grid. Shapes
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
	pause:
		'<rect x="152" y="40" width="56" height="176" rx="8" class="s"/><rect x="48" y="40" width="56" height="176" rx="8" class="s"/>',
	pauseFill:
		'<rect x="152" y="40" width="56" height="176" rx="8"/><rect x="48" y="40" width="56" height="176" rx="8"/>',
	play: '<path d="M72,39.88V216.12a8,8,0,0,0,12.15,6.69l144.08-88.12a7.82,7.82,0,0,0,0-13.38L84.15,33.19A8,8,0,0,0,72,39.88Z" class="s"/>',
	queue:
		'<line x1="40" y1="64" x2="216" y2="64" class="s"/><line x1="40" y1="128" x2="136" y2="128" class="s"/><line x1="40" y1="192" x2="136" y2="192" class="s"/><polygon points="240 160 176 200 176 120 240 160" class="s"/>',
	send: '<line x1="144" y1="128" x2="80" y2="128" class="s"/><path d="M48.49,221.28A8,8,0,0,0,59.93,231l168-96.09a8,8,0,0,0,0-14l-168-95.85a8,8,0,0,0-11.44,9.67L80,128Z" class="s"/>',
	run: '<polygon points="160 16 144 96 208 120 96 240 112 160 48 136 160 16" class="s"/>',
	close: '<line x1="200" y1="56" x2="56" y2="200" class="s"/><line x1="200" y1="200" x2="56" y2="56" class="s"/>',
	edit: '<path d="M92.69,216H48a8,8,0,0,1-8-8V163.31a8,8,0,0,1,2.34-5.65L165.66,34.34a8,8,0,0,1,11.31,0L221.66,79a8,8,0,0,1,0,11.31L98.34,213.66A8,8,0,0,1,92.69,216Z" class="s"/><line x1="136" y1="64" x2="192" y2="120" class="s"/>',
	undo: '<polyline points="24 56 24 104 72 104" class="s"/><path d="M67.59,192A88,88,0,1,0,65.77,65.77L24,104" class="s"/>',
	skull:
		'<path d="M92,104a28,28,0,1,0,28,28A28,28,0,0,0,92,104Zm0,40a12,12,0,1,1,12-12A12,12,0,0,1,92,144Zm72-40a28,28,0,1,0,28,28A28,28,0,0,0,164,104Zm0,40a12,12,0,1,1,12-12A12,12,0,0,1,164,144ZM128,16C70.65,16,24,60.86,24,116c0,34.1,18.27,66,48,84.28V216a16,16,0,0,0,16,16h80a16,16,0,0,0,16-16V200.28C213.73,182,232,150.1,232,116,232,60.86,185.35,16,128,16Zm44.12,172.69a8,8,0,0,0-4.12,7V216H152V192a8,8,0,0,0-16,0v24H120V192a8,8,0,0,0-16,0v24H88V195.69a8,8,0,0,0-4.12-7C56.81,173.69,40,145.84,40,116c0-46.32,39.48-84,88-84s88,37.68,88,84C216,145.83,199.19,173.69,172.12,188.69Z"/>',
	menu: '<line x1="40" y1="128" x2="216" y2="128" class="s"/><line x1="40" y1="64" x2="216" y2="64" class="s"/><line x1="40" y1="192" x2="216" y2="192" class="s"/>',
	plus: '<line x1="40" y1="128" x2="216" y2="128" class="s"/><line x1="128" y1="40" x2="128" y2="216" class="s"/>',
	bell: '<path d="M96,192a32,32,0,0,0,64,0" class="s"/><path d="M56,104a72,72,0,0,1,144,0c0,35.82,8.3,64.6,14.9,76A8,8,0,0,1,208,192H48a8,8,0,0,1-6.88-12C47.71,168.6,56,139.81,56,104Z" class="s"/>',
	reload:
		'<polyline points="184 104 232 104 232 56" class="s"/><path d="M188.4,192a88,88,0,1,1,1.83-126.23L232,104" class="s"/>',
	logout:
		'<polyline points="112 40 48 40 48 216 112 216" class="s"/><line x1="112" y1="128" x2="224" y2="128" class="s"/><polyline points="184 88 224 128 184 168" class="s"/>',
	bug: '<circle cx="156" cy="92" r="12"/><circle cx="100" cy="92" r="12"/><line x1="128" y1="128" x2="128" y2="224" class="s"/><path d="M208,144a80,80,0,0,1-160,0V112a80,80,0,0,1,160,0Z" class="s"/><line x1="232" y1="184" x2="203.18" y2="171.41" class="s"/><line x1="232" y1="72" x2="203.18" y2="84.59" class="s"/><line x1="24" y1="72" x2="52.82" y2="84.59" class="s"/><line x1="24" y1="184" x2="52.82" y2="171.41" class="s"/><line x1="16" y1="128" x2="240" y2="128" class="s"/>',
	google: '<circle cx="112" cy="112" r="80" class="s"/><line x1="168.57" y1="168.57" x2="224" y2="224" class="s"/>',
	check: '<polyline points="40 144 96 200 224 72" class="s"/>',
	checks:
		'<polyline points="16 130.29 54.4 168 144 80" class="s"/><polyline points="125.96 144 150.4 168 240 80" class="s"/>',
}

const grid24 = {
	steer:
		'<path class="s" d="M7 3l0 8.707"/><path class="s" d="M11 7l-4 -4l-4 4"/><path class="s" d="M17 14l4 -4l-4 -4"/><path class="s" d="M7 21a11 11 0 0 1 11 -11h3"/>',
}

export type IconName = keyof typeof phosphor | keyof typeof grid24

export const icons = {
	has(name: string): name is IconName {
		return Object.hasOwn(phosphor, name) || Object.hasOwn(grid24, name)
	},
	/** An icon's inner SVG markup and the grid it is drawn on. */
	svg(name: IconName): { body: string; grid: 24 | 256 } {
		return name in grid24
			? { body: grid24[name as keyof typeof grid24], grid: 24 }
			: { body: phosphor[name as keyof typeof phosphor], grid: 256 }
	},
}
