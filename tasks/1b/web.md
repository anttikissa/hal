# Web code: keep the interface true at every paint

Current guide for `src/web/` (task 1b). The historical `old-web.md` is an
artifact from the previous Hal, not the specification for this one. Read
`tasks/README.md` for the project's architecture, layout and accessibility
rules; read the installed Solid 2 cheatsheet for the exact API of the pinned
runtime. Do not carry Solid 1 or React lifecycle patterns into this app.

## State and rendering

- The browser owns presentation; the host owns conversation truth. `app.ts`
  handles host events and user intent in plain TypeScript; `Chat.tsx` hands
  its state to Solid. Components should bind to specific reactive values,
  not recreate display objects on every keystroke or redraw.
- Preserve identity when a value hasn't changed. Gate snapshots by field
  with `createMemo` and equality, or reconcile server data into a store;
  don't replace an entire tree for a change to one field. A `<For>` needs
  keys that exist from the first byte of an item and remain valid through
  prepends and tab switches. Local UI state belongs to the item, not its
  slot. Don't create DOM in a reactive fallback that rebuilds when data is
  recreated: disappearing/reappearing cards replay entrance animations.
- One mutation should touch only its relevant DOM: typing updates the
  composer, one streamed delta updates one card, an unchanged completion
  list touches no menu node. A list remount that happens fast enough to
  look like a flash is still a correctness and resource-use bug.
- Solid 2 batches writes until a microtask; use `flush()` where an
  imperative event handler must show the outcome before returning or a
  DOM measurement needs the committed layout. Batching does **not** make
  two logically separate writes (erase, then refill on a network reply)
  atomic. `createEffect(compute, apply)` splits tracked reads from side
  effects; use `onSettled` for mount/cleanup. See the installed Solid 2
  cheatsheet, not Solid 1 examples, when choosing a primitive.

## Async data: displayed, pending, absent

- An outstanding request is not an absent answer. Separate the value the
  user can see from the request for a fresher one. Keep the last valid
  display while pending; never use `undefined` as a temporary loading
  marker for a visible value. Dismiss immediately only on a real user
  action or when known data proves it invalid. Reject stale responses by
  their request input/session, without clearing the current view.
- If the client can predict the result (e.g. filtering *known* completion
  candidates for a longer prefix), apply that optimistic result immediately.
  When authoritative data arrives, reconcile differences only; if choices
  and selection are unchanged, keep the same menu and row identities.
  Never optimistically claim knowledge the cached result lacks: a shorter
  prefix may have candidates the previous request did not return.
- Solid 2's async memo can retain the previous value while a replacement is
  pending (`isPending` is separate from the value); optimistic stores/actions
  overlay synchronous writes and reconcile with server truth. Our
  completion source is currently a WebSocket event, not a Promise-backed
  memo or an action: follow the principle in the controller without adding
  a second transport or a cache library merely to use an API. See
  [async reads](https://www.solidjs.com/blog/solid-2-0-rc-the-big-reveal)
  and [optimistic writes](https://www.solidjs.com/blog/async-solid-write-sync-run-async).

## Regressions that reveal architectural mistakes

- Test *between* input and reply, not just the eventual contents. For the
  completion regression (task kx), type `/lo`, wait for `/login` to show,
  hold the next host answer, type `/log`: the same visible choice, DOM row,
  and composer position must survive. Then give an identical reply (still
  no DOM change), and a genuinely different reply (only changed rows may
  update). An older reply must never roll the view back. Check Escape,
  choosing an item and switching sessions still dismiss deliberately.
- Unit-test decisions in plain `.ts` modules; use a real browser with a
  MutationObserver and bounding boxes for retained DOM and layout. Don't
  test source text, copy the JSX into expectations, or test a one-line
  identity function. Test behavior that a plausible wrong implementation
  would break.
