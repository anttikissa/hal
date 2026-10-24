# Style

Hal's look: how the terminal and the web page look and move. Read it
before changing UI. Architecture and behavior live in tasks/README.md.

## Look: retro sci-fi terminal (user's standing preference)

Bold, colorful and contrasty, in the spirit of 2001: A Space Odyssey,
Alien, Blade Runner, Tron and CRT VT100 terminals:

- Saturated phosphor hues on near-black. Never meek, pastel,
  washed-out, corporate-neutral or slate (blue-gray).
- Lit solid edges: a card's left bar is an LED, not a hairline. The
  light comes from color alone, with no glow or blur effects.
- Square corners on cards, buttons, tabs, fields and dialogs.
- Focus and other outlines are 1px, never 2px. A list whose selected
  row shows the focus draws no outline of its own.
- Spacing follows the terminal grid: quarter lines vertically, whole
  ch across. Small text is fine where space is scarce.
- Never use ✗ (U+2717, ballot X): the user finds it ugly. The failure
  mark is × (U+00D7), on the terminal and the web.
- Hover hints look like Hal, never like the browser's gray `title`
  box: themed colors and Hal's font, as in the composer button
  captions ("Sent after this turn ends."). Add a hint only where it
  says something the screen doesn't.
- Propose color changes to the user with options before they land.

Task gn holds the rest of the user's choices (selection, focus, tabs).
Readable text (below) still applies.

## Motion (web)

After Emil Kowalski, loosened by the user (skills/ui-craft, Motion):
animate only opacity, color and transform (the user's exceptions: a
card opening or closing animates its height, as in tasks/4s/demo.tsx
[F12], and a tab marker appearing its width); one strong ease-out
(--ease-out); short (50-300 ms). Each direction is timed by its
frequency: a frequent or keyboard-driven change takes --snap-ms (50
ms), its rare reverse may take up to --back-ms (300 ms); the state
itself changes at once. Motion is CSS; script it only when CSS cannot.
Nothing that happens in milliseconds (a round trip) may show, so state
changes that are usually brief start after a delay; no motion under
prefers-reduced-motion.
Toggles never flash: press feedback is for buttons that act. A
re-render never flashes, blanks or fades what is still the same: old
content stays until its replacement is ready.

## Readable text (invariant, terminal and web)

Never use faint/dim (SGR 2), and never fade text at rest on the web
(opacity, filter or color-mix); animations may pass through it. Every
glyph meets WCAG 2.2 AA contrast against the background it actually
sits on (the block's own, else the lightest dark background we
support): text at least 4.5:1, including placeholders and disabled
items (terminal text is never "large text"); meaningful non-text marks
(Hal cursor, tab glyphs, rules, control borders) at least 3:1. Two
exceptions, the user's choice: the example request in an empty prompt
(oklch.faint; about 3.1:1 on the HAL palette), which says nothing
needed and stays visibly distinct from typed text; and disabled web
composer buttons, whose icon and label fade to 40% opacity so they
read as disabled (2026-10-12).
Hierarchy comes from hue, lightness steps above the minimum or position,
never from dropping below it. Avoid redundant boldface in app UI unless
expressly approved by the user (task sq0). Use slightly brighter color
instead, including for help keys. This does not change explicit bold
formatting in user or model content. Don't overdo testing contrast;
just be careful when introducing new colors.

Status lines start with a capital letter unless there is an overwhelming
reason not to. A line after a destructive command says what happened
and how to go back: ``Context cleared. `/clear undo` to go back.``
