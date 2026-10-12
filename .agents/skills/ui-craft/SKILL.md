---
name: ui-craft
description: Build and review product UI for consistent spacing, alignment, control states, text selection, and responsive behavior. Use for implementation and visual QA, not decorative redesign.
---

# UI craft

## Reuse the system

Read the project's design requirements, tokens, shared controls, and neighboring
screens before editing. Reuse their spacing, type roles, colors, and geometry.
Product requirements override this skill's defaults.

Fix shared defects in their shared owner; check its other consumers. Add reusable
values to existing tokens, but do not build abstractions for a single exception.
Record new design decisions in the project's canonical spec.

## Spacing and alignment

- Use the spacing scale. Equivalent controls share padding, height, and corner
  treatment. Keep related items closer than separate groups.
- Give wrapping controls explicit row and column gaps. Do not rely on whitespace
  or inline line-height. If uneven rows impede scanning, use a vertical list.
- Check repeated left edges, baselines, gutters, and separator insets. Avoid
  doubling the space between groups through both margins and container padding.
- Focus and selection borders must not shift content or change hit areas.
- Before adding offsets, inspect box sizing, computed padding, line-height,
  browser defaults, and font metrics. Prefer layout fixes. Use optical offsets
  only when box alignment leaves a visible mismatch; verify across sizes.

## Tabs and composers

- Align tab labels within their clickable bounds. Use the same inset or centering
  rule for selected and unselected tabs; status markers must not displace labels
  unexpectedly. Indicators may follow label or tab width, but use one rule across
  the set. Keep keyboard focus distinguishable from selection.
- Center single-line input text and caret vertically; align adjacent action labels
  and icons to that center. Check both placeholder and entered text.
- A centered wrapper does not center text inside a textarea. Inspect the editable
  element's own padding, height, and line-height. Do not clip descenders.
- For multiline input, retain padding as it grows; at its height limit, scroll
  content without hiding the caret or covering actions. Do not vertically center
  the whole multiline document.

## Colors, states, and accessibility

- Define foreground and background together for each applicable state: default,
  hover, focus-visible, pressed, selected, disabled, busy, error, and success.
  Check combinations such as selected plus focused, not just isolated states.
- Acknowledge every press in the next frame, visibly enough to notice, for
  mouse, touch, and keyboard activation. A quick tap may never paint `:active`;
  feedback that outlives the press (a brief flash that decays) does.
- Define theme-aware `::selection` foreground and background. Check selected text
  in inputs, prose, code, links, and contrasting surfaces: inherited or syntax
  colors can become unreadable. Check scoped overrides and browser behavior;
  one CSS rule may not reach native controls or shadow DOM.
- Preserve native selection, copy/paste, caret behavior, and forced-color support.
- Check actual contrast pairs, including muted text, placeholders, selection,
  and focus. Do not convey status by color alone. WCAG AA text contrast is
  generally 4.5:1, or 3:1 for large text: at least 24 CSS px, or about 18.67px
  bold. Verify standard levels and exceptions against primary documentation.
- Prefer native controls and existing accessible primitives. Preserve accessible
  names, keyboard operation, visible focus, focus restoration, and usable touch
  targets. ARIA roles do not supply the behavior their widgets require.

## Content and responsive layout

- Exercise long labels, empty content, and multiline content at narrow,
  intermediate, and wide container sizes, especially around wrap boundaries.
- Let flex/grid children shrink where needed. Choose wrapping, scrolling, or
  truncation with a way to retrieve the full content; do not hide essential
  actions, shrink text below the product's minimum, or clip overflow indiscriminately.
- Check text enlargement, font loading, and every supported theme.
- On mobile, check safe areas and the software keyboard: the composer and actions
  must remain reachable. Desktop emulation does not verify keyboard behavior.
- Preserve input, selection, focus, and scroll position through updates. Distinguish
  loading, empty, failed, and stale data. Errors need a recovery path; never claim
  unsaved input is stored unless it is.

## Motion

After Emil Kowalski's animation skills (github.com/emilkowalski/skills),
loosened by the user. Product motion rules override these defaults.

- Name the purpose before animating: feedback, state indication, spatial
  consistency, or preventing a jarring change. Without one, change instantly.
  Do not add noise, glass, glow, or ornamental microinteractions as polish.
- State changes take effect at once; only their look animates. Never delay
  input, focus, or enabled state for an animation.
- Time each direction by its frequency. A frequent or keyboard-driven change
  (typing hides a placeholder, enables Send) takes about 50 ms: 3 frames at
  60 Hz. Its rare reverse (the box empties again) may fade back slower, up to
  about 300 ms, since nobody waits on it. Keep other UI motion under 300 ms:
  presses 100-160 ms, tooltips 125-200 ms, dropdowns 150-250 ms.
- Use one strong ease-out (cubic-bezier(0.23, 1, 0.32, 1)) for entering and
  leaving, plain ease for hover and color, ease-in-out only for movement on
  screen. Never ease-in: it delays the moment the user watches.
- Animate opacity and transform (clip-path when needed). Enter from
  scale(0.95) and opacity 0, never scale(0); anchor popovers at their trigger.
- Use CSS transitions and keyframes; script an animation only when CSS cannot
  express it. Use transitions for anything the user can trigger quickly: they
  retarget from the current value, while keyframes restart.
- Leave the way you entered. Gate hover motion behind
  `@media (hover: hover) and (pointer: fine)`.
- Under prefers-reduced-motion, keep fades and color changes; drop movement.
- Check feel at 2-5x duration or frame by frame; measure suspected jank.

## Completion gate

Inspect the rendered component and its neighbors at the sizes and states above.
Exercise keyboard and pointer/touch paths. Compare before and after under the same
conditions; recheck other consumers of changed shared rules.

Passing tests and source inspection do not establish visual quality. Add tests
according to repository policy, for plausible behavioral regressions rather than
source-text assertions. If rendering or device access is unavailable, state what
remains unverified.

Report findings with component, state, size, and evidence. Separate observed
symptoms from suspected CSS causes. Do not claim checks you did not perform.

Source references and attribution: task z0 notes.
