# Card and panel catalog

## Transcript layout contract

`Card` owns one article, color/state classes, identity, block navigation and
expansion. `CardHeader` owns the first row: recorded time, readable label and
block reference. Native controls and plain text occupy the same grid slots.
All slots start on the first text line, not the center of a multiline neighbor.

Card geometry is the same on every screen; nothing depends on pointer type.
A header row and its controls are at least 44px high. The header has no
additional outer vertical padding; each slot uses the same inset,
(44px - 1lh) / 2, centering one line in the row. Thus single-line folded
cards share one row height.

Every body uses `.content`: quarter-line top padding, one-character
horizontal padding and the header's inset at the bottom, so a card's top
and bottom whitespace match. A headless card's body uses that inset at
the top as well. A folded body has an unpadded clipping wrapper, so its
padding disappears with its content at zero grid height. Do not recreate an
icon-column indent. Block references have their own header column; body text
does not reserve a reference-width gutter down its entire length.

Long folded labels truncate while closed and wrap while open. Times and
references stay on the first line. Native links remain outside the expansion
button. References use generated text, excluded from copying. Records without
time do not invent one. Colors remain the existing theme's responsibility.

| Transcript variant | Header | Body and deliberate differences |
|---|---|---|
| Human prompt | Time + You | Literal text; attachment markers remain links. |
| Prompt from another session | Time + sender/provenance | Markdown; same outer geometry as a human prompt. |
| Background Bash message | Time + sender + link to call | Literal output; successful exit hidden, failure highlighted. |
| Human/model slash command | Time + author/provenance | Literal command; ordinary prompt geometry. |
| Assistant reply | Time + Hal/model | Markdown; streaming cursor follows the body. |
| Command output/error | Time, when recorded | Markdown; ordinary header/body geometry. |
| Thinking | Time + Hal/model/effort + preview | Folded Markdown; empty completed thinking is absent. |
| Tool call/result | Time + description or readable call | Folded call details and attached output; running output may auto-open. |
| Summary-bearing prompt | Time + summary | Folded sender and original body; time is not repeated in the sender line. |
| Queued prompt | Compact queue note until expanded | Three-line preview; expanded agent prose uses the shared header. Waiting items without time retain it in their queue note. |
| Pending prompt | Same header/body as acknowledged prompt | Delayed pending color and reconnect status, not a different shell. |
| Image | No invented sender/time | Linked image constrained to the content width; headless reference. |
| Detached tool result | No invented call timestamp | Result marker and output glimpse; headless reference. |
| Answered/canceled question | No invented timestamp | Question/answer text, not live form controls. |
| Turn end | No header | Completed ends absent; pause/error text remains visible. |
| Context boundary | No header | Label between rules, deliberately not a message header. |

## Surrounding surfaces

| Surface | Shared vocabulary | Intentional structural difference |
|---|---|---|
| Pending Question | Transcript bar, color and spacing scale | Native form, URL text, choices/inputs and dismiss/answer controls. |
| Notices | Lit bar and quarter-line/one-character inset | Floating linked tiles, compact labels and independent stacking. |
| Composer/completions | Lit bar, native controls, same touch minimum | Editable field and selectable suggestions, not transcript articles. |
| Tab sheet rows | Lit selection bar and touch controls | Navigable sessions with independent close buttons. |
| Picker model/Find results | One result-row spacing owner | Text choices versus native navigation links. Linked rows do not add outer and inner vertical padding. |
| Session details dialog | Native dialog and existing modal surface | Read-only live session facts and links. |
| Picker dialog | Native dialog and existing modal surface | Search, result list, filters and effort controls. |
| Tab/Notifications sheets | Existing sheet surface and viewport bounds | Different content and actions; Notifications names its own root component. |
| Login | Native field/button conventions | Standalone authentication form, not a transcript card. |

Do not merge these surfaces into a universal Card or Dialog component merely
because their borders resemble each other. Reuse the smallest common layout
owner whose semantics and geometry are genuinely equivalent. Dialog close
controls and backdrops require a separate product decision before unification.

## Review matrix

Check portrait phone, narrow phone, short landscape phone and desktop. Inspect
short and long labels, closed and expanded cards, images and answered/live
questions. Verify first-line text alignment, equal equivalent row heights,
body inset, reference clearance, wrapping, keyboard expansion, native link
navigation, selection, retained nodes, and touch controls. Inspect rendered
screenshots as well as geometry; physical iOS keyboard/safe-area behavior is
not established by desktop Chrome emulation.
