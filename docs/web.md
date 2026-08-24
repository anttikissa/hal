# Web / SolidJS 2

Read before editing web code. Solid 1 and React patterns are often wrong for our
prerelease Solid 2. Use the installed `solid-js/CHEATSHEET.md` as the API source
of truth; re-read it after upgrades.

## Where the code lives

- `src/web-client/` — the browser app: `main.tsx`, `components/`, `utils/`, `index.html`,
  `styles.css`. It may import `src/common/` and `src/utils/`, never `src/server/` or
  `src/client/`.
- `src/server/web.ts` — HTTP and WebSocket transport, started only for `hal --web`. It serves
  the page, bundles the browser code lazily on first request, sends a `ClientSessionSnapshot`
  on subscribe, and streams live events after that.
- `src/common/web.ts` — the wire message contract plus `webMessages.applySessionMessage`, which
  folds snapshots and events into one session state. Presentation belongs in `web-client`;
  event-to-block projection belongs in `src/common/live-event-blocks.ts`.

## Stack

- Update the locked `solid-js` and `@solidjs/web` versions together.
- Set `jsxImportSource` to `@solidjs/web`.
- Import core and stores from `solid-js`; import DOM APIs and JSX types from
  `@solidjs/web`. `solid-js/web` and `solid-js/store` are gone.
- The client-only app has no router dependency; see "Routing" below.

## Routing

`src/web-client/router.ts` is a ~70-line router, not a dependency. The whole
URL surface is `/<sessionId>` (`hal.kissa.dev/05-wan`), so a tab is a
shareable link and Back/Forward move between tabs.

- `src/common/web.ts` owns `isSessionPath()`. The server serves the app for
  those paths and the client parses the session out of the same shape, so the
  two can never disagree about what a session URL is.
- The router is the single source of truth for the selected session: `main.tsx`
  derives `selected` from `router.sessionId()` rather than keeping its own
  signal. `popstate` therefore needs no special case.
- `navigate(id, { replace })`: user actions push, app reconciliation replaces.
  Landing on a tab you did not ask for must not add history entries.
- `href`/`write` are indirections over `location`/`history` so tests drive the
  router without a DOM and eval can hot-patch navigation.

### Why not Solid Router or TanStack Router

Both are good, and both solve problems we do not have. Their value is nested
layouts, route-tree config, loaders/preloading with caching, and typed path
builders — TanStack's headline feature is inferred types and route codegen,
which is an explicit non-goal here. We have one flat route, no nesting, and a
WebSocket that already pushes our data, so a route loader has nothing to load.

Adopt one when we actually grow nested layouts, several route families, or
route-owned data loading. Until then the dependency costs more than the
`if`-statement it replaces. Note Solid Router 2 is itself prerelease and its
v2 docs are still thin, which is another reason not to bet the client on it.

## Components, files, and CSS

- `components/` is for files that each export **one JSX component**. It is a useful
  strict boundary: do not put helpers, state primitives, protocol code, or a group of
  unrelated components there.
- Put non-component helpers in a purpose-named directory such as `utils/` only when
  they exist and are shared. Do not create empty category directories in advance.
- Keep shared component styling in one `styles.css` until separate stylesheets earn
  their complexity. Scope selectors to the component's root class, not generic tags:

  ```tsx
  function SessionTabs() {
  return <header class="SessionTabs">...</header>
  }
  ```

  ```css
  .SessionTabs > button { ... }
  .SessionTabs > button.selected { ... }
  ```

  The root class matches the component name, so styles have an obvious owner and do
  not leak into another component's `button`, `h1`, or `main`.

## Reactivity

- Call signals and memos to read them. Writes are microtask-batched; do not rely
  on `setX(value); x()`. Use `flush()` only at imperative or test boundaries,
  not as a replacement for removed `batch()`.
- `createEffect(compute, apply)` tracks reads in `compute`; `apply` is untracked
  and performs side effects.
- Use `onSettled(() => { ...; return cleanup })` for component setup/teardown.
  `onCleanup` is for cleanup tied to a reactive computation.
- Do not write state during component rendering, memos, or effect computation.
  Read reactive values in JSX or computations, not at a component's top level.
- Pass prop values (`<X value={count()} />`), not accessors. Use `props.value`;
  destructuring props loses reactivity.
- Mutate store drafts: `setStore(draft => { draft.user.name = name })`. To
  preserve server-data identity, call `reconcile(data, key)(draft.branch)` in it.
- `snapshot(store)` takes a plain non-reactive copy for serialization or tests.
  Note `main.tsx` already uses `snapshot` as a local name for session data, so
  check for shadowing before importing it there.

Dev builds turn the two most common Solid 1 reflexes into thrown errors, so a
crash here means the idiom changed, not that the code is subtly broken:

- `[MISSING_EFFECT_FN]` — `createEffect` got one argument. Split it into
  `(compute, apply)`, or use `createMemo` for a derived value.
- `[REACTIVE_WRITE_IN_OWNED_SCOPE]` — a setter ran inside a component body,
  memo, effect compute, or `createRoot` callback. Move the write to an event
  handler or `onSettled`, or opt in with `createSignal(v, { ownedWrite: true })`.

## Async

- Async work belongs in computations: `createMemo(() => fetch(...))` returning a
  promise, read under `<Loading>`. There is no `createResource`.
- Plain `async` handlers that call a setter are still fine, and are what
  `main.tsx` does for fetch and WebSocket traffic. Prefer them when the data
  arrives by push rather than by reading a value.
- `isPending(() => x())` is not 1.x `.loading`. It reports an in-flight *change*
  to a value that already rendered, so it stays false during a plain `refresh`.
- `refresh(x)` silently re-asks the same question. Pair it with `affects(x)`
  first when the reload should read as pending.
- `action` bodies are generators: `yield` promises to stay in the transaction,
  never `flush()` inside one, and call them from handlers, not components.

## Solid 1 traps

- `Errored` replaces `ErrorBoundary`; `Reveal` replaces `SuspenseList`. See
  Async above for what replaced `createResource` and `Suspense`.
- `merge`, `omit`, and `onSettled` replace `mergeProps`, `splitProps`, and
  `onMount`; draft setters replace `produce`.
- Default `<For>` children get a value and index accessor; `keyed={false}` gives
  an item accessor and numeric index. `<Show>` function children get an accessor
  unless keyed.
- Context is its provider: `<Context value={value}>`. Refs are callbacks or
  callback arrays, not ref objects or `use:` directives.
- Use lowercase HTML attributes, camelCase events, and `class` arrays/objects,
  not `classList`, namespaces, or hand-built conditional class strings.
- `<Repeat count={n}>` renders a count with no diffing and has no Solid 1
  equivalent, so it is easy to miss when reaching for `<For>` over an index.

## Tests

No web test imports `solid-js` yet. The first one that does must deal with this:

- **Bun resolves Solid's server build by default, and it fails silently.**
  `solid-js` points `main`/`module` at `dist/server.js`; the client build sits
  behind the `browser` condition. Under the server build memos never recompute
  and effect apply never runs, so assertions pass against stale values instead
  of erroring. Only `bun test --conditions browser --conditions development`
  fixed it in a probe; `conditions` under `[test]`, `[run]`, or `[install]` in
  `bunfig.toml` was ignored, so `scripts/test-parallel.ts` needs the flags when
  it spawns a test that touches Solid.
  Sanity check: `createMemo(() => c() * 2)` must observe a `setC(5)` after
  `flush()`. If it returns the initial value, the build is wrong, not the test.
- Give primitives an owner with `createRoot` outside render tests, but call
  setters *outside* the `createRoot` callback — it is an owned scope, so writing
  inside it throws `[REACTIVE_WRITE_IN_OWNED_SCOPE]`. Return the setter and use
  it after.
- `flush()` before assertions that observe queued state, effects, or DOM.

Source: [Solid 2 cheatsheet](https://github.com/solidjs/solid/blob/next/packages/solid/CHEATSHEET.md).
