# Web / SolidJS 2 guide

**Read this before writing any web (SolidJS) code.**

We are building our web app on **SolidJS 2.0 RC**. No model has been trained on
Solid 2 code, because almost none exists in public yet. Pattern-matching from
Solid 1.x (or worse, from React) produces code that is *confidently wrong* here:
`createEffect` has a different signature, setters no longer update reads
immediately, `createResource` / `Suspense` / `batch` / `produce` are gone, and
half the imports moved packages.

So: do not generate Solid code from memory. Read this file first, every time.

## Versions we target

| Package | Version | Notes |
| --- | --- | --- |
| `solid-js` | `2.0.0-rc.0` | `npm:next` tag. Stores now live here. |
| `@solidjs/web` | `2.0.0-rc.0` | DOM renderer + JSX types. `jsxImportSource: "@solidjs/web"`. |
| `@solidjs/vite-plugin` | `3.0.0-next.28` | replaces `vite-plugin-solid` |

Note the packages are on **different prerelease tracks** (`rc` vs `next`). When
upgrading, move the whole set together and re-verify; the RC docs warn that
packages from the coordinated RC must use compatible versions.

## Routing: we don't have a router yet

Deliberately no router dependency. Our URL needs are tiny:

- `/112-bad` → open that session
- `/112-bad#0083pn-l13` → scroll to that message
- possibly `/blob/<id>` → show a single blob

That is a path segment plus a hash. It does not justify a routing library.
Start with `location.pathname` / `popstate` / `history.pushState` and a signal.

If routing genuinely grows complex (nested layouts, typed params, preloading,
SSR data), we can adopt `@solidjs/router@2.0.0-next` or the TanStack equivalent
— but only then, and only if the benefit is clear. Follow the lazy ladder.

## Sources

1. **Part 1** below is the official cheatsheet by Ryan Carniato, shipped as
   `node_modules/solid-js/CHEATSHEET.md` in `solid-js@2.0.0-rc.0`
   (<https://github.com/solidjs/solid/blob/next/packages/solid/CHEATSHEET.md>).
2. **Part 2** is extra material from
   <https://v2.solidjs.com/migration/from-solid-1> that the cheatsheet omits.
3. **Part 3** is our own verification notes — things we hit in practice that the
   docs do not say. Kept separate on purpose; we fold it into Part 1 later.

Tip: every page on <https://v2.solidjs.com> serves clean markdown if you append
`.md` to the URL (e.g. `https://v2.solidjs.com/concepts/stores.md`). Use that
instead of scraping HTML. `sitemap.xml` lists all 141 pages.

---

# Part 1 — Official Solid 2.0 cheatsheet

Near-verbatim from upstream, so it can be diffed against future releases; the
only change is the two "See also" links, which point at `main` upstream and 404.
Edit it freely when that makes it clearer to read.

---

# Solid 2.0 — Cheatsheet

One-page reference for Solid 2.0. Every API exists in `solid-js` unless noted. DOM APIs are in `@solidjs/web`.

> **AI codegen warning.** Solid is **not React**, and 2.0 is **not 1.x**. Both priors are dominant bug sources here — distrust pattern-matching from either. The bottom of this file lists 2.0-specific corrections; read them before generating code.

---

## Imports

```ts
import {
  createSignal,
  createMemo,
  createEffect,
  createRoot,
  For,
  Show,
  Switch,
  Match,
  Loading,
  Errored,
  Repeat,
  Reveal,
  createStore,
  createProjection,
  snapshot,
  reconcile,
  merge,
  omit,
  action,
  createOptimistic,
  createOptimisticStore,
  isPending,
  latest,
  refresh,
  affects,
  untrack,
  flush,
  onSettled,
  createContext,
  useContext,
  children,
  lazy,
  createUniqueId
} from "solid-js";

import { render, hydrate, Portal, dynamic, Dynamic } from "@solidjs/web";
```

Web projects should configure TypeScript with `"jsxImportSource": "@solidjs/web"`.
`solid-js` no longer provides `solid-js/jsx-runtime`; renderer packages own JSX types.

Old subpaths are gone:
`solid-js/web` → `@solidjs/web`. `solid-js/store` → `solid-js`. `solid-js/h` → `@solidjs/h`. `solid-js/html` → `@solidjs/html`. `solid-js/universal` → `@solidjs/universal`.

---

## Signals & memos

```ts
// Plain signal
const [count, setCount] = createSignal(0);
count(); // read (call it!)
setCount(1); // queues; read returns last committed until flush
setCount(c => c + 1); // updater form

// Readonly derived
const doubled = createMemo(() => count() * 2);
doubled();

// Writable derived ("writable memo")
const [value, setValue] = createSignal(() => props.initial);

// Options
createSignal(0, { ownedWrite: true }); // allow writes from inside owned scope
createSignal(0, { unobserved: () => cleanup() }); // fires when no subscribers
createMemo(fn, { lazy: true }); // defer first compute until read; autodispose when unobserved
createMemo(fn, { equals: (a, b) => a.id === b.id });
```

**Reads update only after flush.** `setX(v); x()` returns the _previous_ value until the next microtask or `flush()`.

```ts
setCount(1);
count(); // still 0
flush();
count(); // 1
```

---

## Effects

```ts
// Two-arg form is the only form. Compute tracks; apply runs side effects.
createEffect(
  () => count(), // compute (tracks)
  (value, prev) => {
    // apply (untracked)
    el.title = value;
    return () => {
      /* cleanup */
    }; // optional cleanup
  }
);

// With error handling
createEffect(() => fetchData(id()), {
  effect: data => render(data),
  error: (err, cleanup) => console.error(err)
});

// Run on next change only (skip initial)
createEffect(
  () => count(),
  v => log(v),
  { defer: true }
);

// Schedule once after the current activity settles — the canonical
// "do this once and clean it up on dispose" primitive (replaces 1.x
// onMount + onCleanup for component-level lifecycle).
onSettled(() => {
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
});
```

`onSettled` works in component bodies (after first reactive settle) **and** in event handlers (defer work until the triggered transition settles). For component-level setup-and-teardown, **use `onSettled` with a returned cleanup, not `onCleanup` directly** — `onCleanup` is reserved for reactive cleanup inside computations (see Advanced).

---

## Reactive control utilities

```ts
untrack(() => count()); // read without subscribing
flush(); // drain queued updates synchronously
isEqual(a, b); // default equality
```

---

## Stores

```ts
const [store, setStore] = createStore({ user: { name: "A" }, list: [] });

// Draft-first setter (canonical)
setStore(s => {
  s.user.name = "B";
  s.list.push("x");
});

// Return a value when mutation is awkward (filter/remove most often).
// Arrays replace by index + length; objects shallow-diff at the top level.
// No keyed reconciliation here — for that, use createProjection / createStore(fn).
setStore(s => s.list.filter(x => x !== "x"));
setStore(s => ({ ...s, list: [] }));

// Reconcile new data into a sub-tree (preserve identity)
setStore(s => {
  reconcile(serverTodos, "id")(s.todos);
});

// Derived stores (mirror signal/memo split)
const items = createProjection(async () => api.list(), [], { key: "id" }); // readonly
const [cache, setCache] = createStore(
  draft => {
    draft.x = compute();
  },
  { x: 0 }
); // writable
```

`undefined` is a real value in `merge` / setters — it overrides, not "skip".

---

## Props

**Props are reactive values, not accessors.** Two rules, one underlying model — and together the most common AI-generated bug class in Solid.

```jsx
const [count, setCount] = createSignal(0);

// 1. At the call site: pass the VALUE. Call accessors at the JSX boundary.
<Counter value={count()} />            // ✅
<Counter value={count} />              // ❌ child receives a function, not a number

// 2. In the child: read via `props.x`. The *property access* is what tracks.
function Counter(props) {
  return <div>{props.value}</div>;     // ✅ re-reads on each render
}
function Counter({ value }) {          // ❌ destructure unwraps once, reactivity is dead
  return <div>{value}</div>;
}
```

The rules are two sides of the same boundary: the parent collapses its accessors to values when handing off; the JSX runtime re-wraps `props` so that `props.value` re-reads on each access. Skip step 1 and the child gets a function; skip step 2 and the child reads once.

If you genuinely need to forward a getter (rare — render props, lazy slots), pass `getValue={() => count()}` and document it. Default to values.

### Helpers

```ts
const merged = merge(defaults, props, overrides); // replaces mergeProps
const rest = omit(props, "class", "style"); // replaces splitProps
```

---

## Async

```ts
// Async is just "any computation that returns a Promise / AsyncIterable"
const user = createMemo(() => fetchUser(id()));
// Reading user() is not ready at first; wrap in <Loading>.

// True while a value CHANGE is in flight for this read (e.g. id() changed and
// the refetch hasn't landed). Place under the Loading boundary that owns it.
<Loading fallback={<Spinner />}>{isPending(() => user()) ? "Updating..." : user()}</Loading>;
// isPending can live outside Loading when it only reads upstream state that cannot be not ready.

// Peek at the in-flight value during a transition
latest(id);

// Force recompute of a derived read after a server write.
// Action: call from handlers/effects/actions, not pure reads.
// A bare refresh() re-asks the SAME question — it is quiet (isPending stays
// false; the fresh value reveals silently). To make a reload read as pending,
// declare it:
affects(user);
refresh(user);
```

---

## Actions & optimistic

```ts
const [todos, setOptimisticTodos] = createOptimisticStore(() => api.list(), []);

const addTodo = action(function* (todo) {
  setOptimisticTodos(s => {
    s.push(todo);
  }); // optimistic write — shows the expected value; never reads as pending itself
  yield api.add(todo); // async work
  refresh(todos); // reconcile with source of truth (quiet — same question)
});

// Declare data the in-flight work WILL change (reads as pending until settle):
const rename = action(function* (todo, text) {
  setOptimisticTodos(() => {
    todo.text = text;
  });
  affects(todo, "updatedAt"); // server changes this slot too — pend it
  yield api.rename(todo.id, text);
  refresh(todos);
});

// Optimistic signal
const [name, setName] = createOptimistic("Alice");
```

Optimistic writes revert when the transition completes. Division of labor: optimistic writes _show_ the expected value, `affects` _pends_ data you know is changing but can't show yet, and process affordances ("saving…") are a co-written `createOptimistic(false)` flag — not `isPending`.

---

## Control-flow components

```tsx
// List, keyed by identity (default)
<For each={items()}>
  {(item, i) => <Row item={item} index={i()} />}
</For>

// List, non-keyed (replaces <Index>)
<For each={items()} keyed={false}>
  {(item, i) => <Row item={item()} index={i} />}
</For>

// List with custom key
<For each={items()} keyed={t => t.id} fallback={<Empty />}>
  {item => <Row todo={item()} />}
</For>

// Range / count (no diffing) — i is a plain number, not an accessor
<Repeat count={store.items.length} fallback={<Empty />}>
  {i => <Row name={store.items[i].name} />}
</Repeat>

// Conditional (function child receives narrowed accessor — call it!)
<Show when={user()} fallback={<Login />}>
  {u => <Profile user={u()} />}
</Show>

// Branching
<Switch fallback={<NotFound />}>
  <Match when={route() === "home"}><Home /></Match>
  <Match when={route() === "profile"}>{() => <Profile />}</Match>
</Switch>

// Async boundary (replaces <Suspense>)
<Loading fallback={<Spinner />} on={id()}>
  <Profile />
</Loading>

// Error boundary (replaces <ErrorBoundary>)
// reset is an action for retrying the errored branch.
<Errored fallback={(err, reset) => <button onClick={reset}>retry {String(err())}</button>}>
  <Page />
</Errored>

// Coordinate sibling Loadings (replaces <SuspenseList>).
// Default order is "sequential" — siblings reveal in registration order
// as each resolves. `collapsed` (sequential only) suppresses tail-sibling
// fallbacks past the frontier. Other orders: "together" | "natural".
<Reveal collapsed>
  <Loading fallback={<S/>}><A/></Loading>
  <Loading fallback={<S/>}><B/></Loading>
</Reveal>

// Dynamic component — factory form (canonical). Stable Component identity;
// composes with lazy(), routing, polymorphic patterns.
import { dynamic } from "@solidjs/web";

const Active = dynamic(() => isEditing() ? Editor : Viewer);
return <Active value={value()} />;

// JSX-wrapper convenience form. Use when the source is inline and you don't
// need to capture the component identity.
import { Dynamic } from "@solidjs/web";
<Dynamic component={isEditing() ? Editor : Viewer} value={value()} />
```

`<For>` non-keyed: `item` is an **accessor** and `i` is a plain number.
`<For>` default/keyed-by-identity: `item` is a **plain value** and `i` is an accessor.
`<Repeat>`: `i` is a **plain number**.

---

## Context, components, lazy

Context is for state scoped to a subtree of the component tree. **If you
want truly app-wide state, don't use Context — a module-scope signal/store
_is_ a global.** That's why the default-less form requires a Provider.

```tsx
// Default-less — the canonical form. No Provider → ContextNotFoundError.
type TodosCtx = readonly [Store<Todo[]>, TodoActions];
const TodosContext = createContext<TodosCtx>();

function App() {
  return (
    <TodosContext value={createTodos()}>
      {" "}
      {/* the context IS the provider */}
      <TodoList />
    </TodosContext>
  );
}

function TodoList() {
  const [todos, { addTodo }] = useContext(TodosContext); // typed as TodosCtx
  // ...
}
```

```tsx
// Default form — only for primitive fallbacks (theme, locale, frozen config).
// Outside any Provider, useContext returns the default.
const Theme = createContext<"light" | "dark">("light");

function Page() {
  const theme = useContext(Theme); // "light" | "dark"
  return <div class={theme}>...</div>;
}
```

Don't write a `useTodos`-style wrapper that re-throws on missing Provider —
the default-less form already throws, and `useContext` is typed `T` (no
`| undefined`). The wrapper is React-flavored boilerplate that no longer
earns its keep.

```tsx
// Resolve children once
const list = children(() => props.children);
list.toArray();

// Async component
const Heavy = lazy(() => import("./Heavy"));
```

Component types:

```ts
type Basic = Component<P>; // no implicit children
type Empty = VoidComponent<P>; // forbids children
type WithChildren = ParentComponent<P>; // optional renderer-neutral Element children
type Flow = FlowComponent<P, C>; // requires children of type C
```

---

## DOM rendering

```ts
import { render, hydrate, Portal } from "@solidjs/web";

const dispose = render(() => <App />, document.getElementById("root")!);
hydrate(() => <App />, document.getElementById("root")!);

<Portal mount={document.body}><Modal /></Portal>
```

### Refs and directives

```jsx
// Element access
<button ref={el => (myButton = el)} />

// Directive factory (replaces use:)
<input ref={autofocus} />
<button ref={tooltip({ content: "Save" })} />

// Compose multiple
<button ref={[autofocus, tooltip({ content: "Save" })]} />
```

Two-phase directive (recommended):

```ts
function titleDirective(source) {
  // Setup phase (owned): create primitives.
  let el;
  createEffect(source, value => {
    if (el) el.title = value;
  });
  // Apply phase (unowned): DOM writes only.
  return nextEl => {
    el = nextEl;
    el.title = source();
  };
}
```

### Attributes

```jsx
<video muted={true} />              // boolean = presence/absence
<video muted={false} />
<some-element enabled="true" />     // when platform requires the string
```

Lowercase HTML attribute names. No `attr:` / `bool:` / `on:` / `oncapture:` namespaces. Event handlers stay camelCase (`onClick`).

For native listener options, use a ref callback:

```jsx
const on = (type, handler, options) => el => el.addEventListener(type, handler, options);

<button ref={on("click", handleClick, { capture: true })} />;
```

### Conditional classes — always use the array/object form

```jsx
<div class="card" />                                          // static string
<div class={{ active: isActive(), invalid: !valid() }} />     // object: toggle by truthiness
<div class={["card", props.class, { active: isActive() }]} /> // array: merge entries
```

Array entries are always-on (or further nested arrays/objects). Object entries toggle by truthiness. There is no `classList` prop — the array+object form replaces it.

**Don't build class strings manually.** String concatenation, template literals, and `.join(" ")` over conditionals are the React/`classnames` reflex. Use the array+object form so conditions compose:

```jsx
<li class={["todo", { completed: props.todo.completed, errored: !!err() }]} />; // ✅

const cls = [
  "todo", // ❌
  props.todo.completed && "completed",
  err() && "errored"
]
  .filter(Boolean)
  .join(" ");
return <li class={cls} />;
```

---

## SSR (server entry)

```ts
import { renderToString, renderToStream, isServer, isDev } from "@solidjs/web";
```

`Portal` throws on the server. `Reveal` `order="together"` and `collapsed` require streaming (`renderToStream` — awaiting it yields the fully settled HTML string).

---

## Diagnostics (dev mode)

Common dev-mode warnings/errors you may hit:

- **Top-level reactive read in component body** — read inside JSX or wrap in `untrack`/`createMemo`.
- **Write under owned scope** — move setters into event handlers / `onSettled` / `untrack`, or opt in with `{ ownedWrite: true }`.
- **Strict read untracked** — extract values in the compute phase; don't read store proxies inside the effect callback.
- **Multiple Solid instances** — single `solid-js` install required.

Each diagnostic has a code (see RFC 08 / runtime error message) — search the docs by code.

---

## Advanced / escape hatches

Reach for these only when the named situation applies. **If you're not sure, you don't need them** — the common-path APIs above are the answer.

```ts
// Reactive cleanup inside a computation — runs before the next compute and
// on disposal. For component-level setup-and-teardown, use onSettled and
// return a cleanup; onCleanup is for library/primitive internals where the
// cleanup is tied to a reactive run, not a component lifecycle.
onCleanup(() => disposeReactiveResource());

// Deep tracking — only when an effect needs to react to *any* nested store change.
// Default store tracking is property-level (preferred).
createEffect(
  () => deep(store),
  snap => save(snap)
);

// Plain (non-reactive) deep copy of a store. For serialization (JSON.stringify,
// localStorage, sending over the wire) and tests that need a plain-object
// assertion target. Inside reactive scopes, prefer reading individual values.
JSON.stringify(snapshot(store));

// Render-phase synchronous effect — for DOM bindings that must run during render
// (the runtime's own attribute/property bindings). For app code, use createEffect.
createRenderEffect(
  () => props.title,
  v => {
    el.title = v;
  }
);

// Single-callback effect that may re-run in async situations.
// Rare; prefer createEffect.
createTrackedEffect(() => log(count()));

// One-shot tracked callback (advanced reactive patterns).
const track = createReaction(() => doWork());
track(() => count());

// Manually create an owned reactive scope. App code uses render(); reach for
// createRoot in tests, library setup, and other non-render entry points where
// you need an owner so reactive primitives can dispose properly.
createRoot(dispose => {
  const [count, setCount] = createSignal(0);
  // ...
  dispose();
});

// Detach a root from its parent (module singletons, external integrations only).
runWithOwner(null, () => {
  /* ... */
});

// Get the current owner. Mostly used to capture and restore an owner across an
// async boundary inside library code.
const owner = getOwner();
runWithOwner(owner, () => {
  /* ... */
});

// Wait for a reactive expression to settle (imperative code / tests).
const v = await resolve(() => user());

// Throw to signal "not ready" through the reactive graph (library authors).
throw new NotReadyError();

// 1.x-style path setter compat. Use only when migrating; draft-first is canonical.
setStore(storePath("user", "address", "city", "Paris"));
```

---

## What changed from 1.x (the AI footgun list)

If your training data is 1.x, these are the corrections. **Read this before generating Solid 2.0 code.**

### Imports moved

- `solid-js/web` → `@solidjs/web`
- `solid-js/store` → `solid-js` (store APIs moved into core)
- `solid-js/h` / `solid-js/html` / `solid-js/universal` → `@solidjs/h` / `@solidjs/html` / `@solidjs/universal`
- `jsxImportSource: "solid-js"` → `"@solidjs/web"` for web JSX (`@solidjs/h` for hyperscript JSX)

### Renames

| 1.x                 | 2.0                                                       |
| ------------------- | --------------------------------------------------------- |
| `Suspense`          | `Loading`                                                 |
| `SuspenseList`      | `Reveal`                                                  |
| `ErrorBoundary`     | `Errored`                                                 |
| `mergeProps`        | `merge`                                                   |
| `splitProps`        | `omit`                                                    |
| `unwrap`            | `snapshot`                                                |
| `onMount`           | `onSettled`                                               |
| `createSelector`    | `createProjection` (or `createStore(fn)`)                 |
| `equalFn`           | `isEqual`                                                 |
| `getListener`       | `getObserver`                                             |
| `Context.Provider`  | `<Context value={...}>` (context value _is_ the provider) |
| `classList={{...}}` | `class={{...}}` (object/array forms)                      |

### Removed (with replacements)

| Removed                            | Use instead                                                         |
| ---------------------------------- | ------------------------------------------------------------------- |
| `batch`                            | Default microtask batching; `flush()` to apply now                  |
| `createComputed`                   | `createMemo` / split `createEffect` / function-form `createSignal`  |
| `createResource`                   | Async computations + `<Loading>` (`createMemo(() => fetchX(id()))`) |
| `startTransition`, `useTransition` | Built-in transitions; `isPending` / `<Loading>` / optimistic APIs   |
| `on(...)` helper                   | Split effects (compute phase = explicit deps)                       |
| `onError` / `catchError`           | `<Errored>` or effect `error` option                                |
| `produce`                          | Default — store setters are draft-first                             |
| `createMutable` / `modifyMutable`  | `createStore` with draft setters                                    |
| `from` / `observable`              | Async iterables in computations / `createEffect` to push out        |
| `Index`                            | `<For keyed={false}>`                                               |
| `indexArray`                       | `mapArray` (handles non-keyed too)                                  |
| `use:foo={x}` directives           | `ref={foo(x)}` (or array `ref={[a, b(x)]}`)                         |
| `attr:` / `bool:` namespaces       | Standard attribute behavior                                         |
| `on:` / `oncapture:`               | `onClick` for Solid events; ref callbacks for native listener opts  |
| `resetErrorBoundaries`             | Boundaries heal automatically                                       |

### Behavior changes

- **`createEffect` takes two arguments now**: `(compute, apply)`. The single-arg form is gone — using it is an error.
- **Setters don't update reads immediately** — values become visible after the microtask flushes (or via `flush()`).
- **No writes inside owned scope** — writing a signal/store from inside a memo, effect compute, or component body throws in dev. Move writes to event handlers, `onSettled`, or untracked blocks. Opt in narrowly with `{ ownedWrite: true }` for internal state.
- **No top-level reactive reads in component body** — reading signals/props directly at the top of a component warns. Read inside JSX, a memo, or `untrack`.
- **Props are values, not accessors** — at the call site call accessors (`<X v={count()} />`, not `<X v={count} />`). The single most common AI-generated bug.
- **Don't destructure props** — `function Comp({ name })` warns; use `props.name` to keep reactivity. (Same root cause as above; see the Props section.)
- **`<For>` callback shape follows keying** — default/keyed-by-identity receives a raw item and index accessor; `keyed={false}` receives an item accessor and stable numeric index; custom keys receive accessors.
- **`<Show>` / `<Match>` function children narrow values** — non-keyed children receive accessors; keyed children receive raw values.
- **Stores: setters take a draft callback** — mutate the draft in place by default. Returning a new value is shallow (array index-replace, object top-level diff); reach for it for filter/remove. Keyed reconcile is a _projection-fn_ feature, not a setter feature.
- **`undefined` is a real value in `merge`** — it overrides rather than "skip this key".
- **Async lives in computations** — return a Promise/AsyncIterable from `createMemo`/`createStore(fn)`/`createProjection`. Pending reads participate in `<Loading>`.
- **`Loading` covers unresolved branches** — once content has rendered, revalidation keeps it visible. Use `isPending(() => x())` for in-flight-change indicators or render guards; it reads `x` and participates in Loading like that read. Use `<Loading on={key}>` to re-show fallback on key changes.
- **`isPending` ≠ 1.x `.loading`** — it fires while a value _change_ is in flight (an input changed, or `affects()` declared one), not for every fetch. A bare `refresh()`/poll re-asks the same question and is silent. For a reload that should read as pending: `affects(x); refresh(x)`. For a "saving…" affordance: a co-written optimistic flag.
- **No `Suspense.Provider` or single error path** — async errors flow to `<Errored>` (or effect `error`); no inline `resource.error` branching.
- **`createRoot` is owned by parent by default** — disposed when parent disposes. To detach: `runWithOwner(null, fn)`.
- **Refs are functions** — `ref={el => ...}`. No `useRef`-style ref objects. Compose with arrays: `ref={[a, b]}`.
- **Boolean attributes are presence/absence** — `<video muted={false} />` removes the attribute.
- **Built-in attributes are lowercase** — `tabindex` not `tabIndex`. Event handlers stay camelCase (`onClick`).
- **In tests, `flush()` before asserting on signals** — `setCount(1); flush(); expect(count()).toBe(1)`.
- **Reactive primitives need an owner** — wrap test code in `createRoot(dispose => { ... })` or you'll leak.

---

## See also

- [`MIGRATION.md`](https://github.com/solidjs/solid/blob/next/documentation/solid-2.0/MIGRATION.md) — full beta-tester migration guide.
- [Solid 2.0 RFCs](https://github.com/solidjs/solid/tree/next/documentation/solid-2.0) — deep-dive design docs by subsystem.

---

# Part 2 — Extras from the official migration guide

Source: <https://v2.solidjs.com/migration/from-solid-1> (fetched 2026-08-14).
This section only covers points the cheatsheet above does *not* make, or makes
too briefly. Where the two disagree, prefer the cheatsheet — it ships with the
package.

## Migration is all-or-nothing at the package boundary

Solid 2 does not ship the old `solid-js/web` or `solid-js/store` entry points at
all, and `@solidjs/web` requires Solid 2 as a peer. Runtime, renderer, JSX
compiler, and integrations must be upgraded as one dependency set. Any
third-party primitive/library needs an explicitly Solid-2-compatible release —
a passing typecheck proves nothing, because compiler transforms, root event
delegation, hydration IDs, and async scheduling are runtime contracts.

Also moved: `solid-js/h` → `@solidjs/h`, `solid-js/html` → `@solidjs/html`,
`solid-js/universal` → `@solidjs/universal`, and `solid-js/jsx-runtime` →
renderer-owned entries such as `@solidjs/web/jsx-runtime`.

Import DOM-specific `JSX` and `ComponentProps` types from `@solidjs/web`. Use
renderer-neutral types (`Component`, `Element`) from `solid-js` when an API does
not depend on DOM JSX.

## Effects and memos: signature details

- The Solid 1 `initialValue` argument is **removed** from both `createEffect`
  and `createMemo`. The compute function receives `prev`, which is `undefined`
  on the first run — use a default parameter if you need a seed:
  `createMemo((prev = 0) => prev + count())`.
- The second argument of `createMemo` is now its **options object**, not an
  initial value.
- Replace `on(deps, fn)` with the compute phase, plus the effect `defer` option
  when you need to skip the first run.
- Extract store properties in the **compute** phase. Do not pass a store proxy
  through to the untracked apply phase and read it there — apply-phase reads do
  not track, and dev mode flags this ("strict read untracked"):

  ```ts
  createEffect(
    () => ({ name: user.name, role: user.role }),
    value => sendAnalytics(value.name, value.role)
  );
  ```

- `createTrackedEffect` and `onSettled` **cannot create nested primitives**.
  Use `createEffect` when you need to create primitives inside.
- `flush()` is only for imperative boundaries that must observe updated state or
  DOM before the next microtask — chiefly tests. Do **not** blanket-replace
  Solid 1 `batch` calls with `flush`; that converts deferred work into
  synchronous work. Consecutive writes already share the default microtask
  batch. `flush(fn)` runs `fn` in a synchronous flush scope and drains the queue
  before returning.

## Stores: migration helpers

`reconcile` now runs against the selected draft rather than being passed to a
path setter:

```ts
// Solid 1
setState("todos", reconcile(serverTodos));
// Solid 2
setState(draft => { reconcile(serverTodos, "id")(draft.todos); });
```

`storePath` is an explicit **migration helper** for path setters that cannot be
converted in one go — `setState(storePath("user", "address", "city", "Paris"))`.
It supports indexed, filtered and ranged paths, so preserve the original path
semantics when converting complex setters. Prefer draft setters in new code.

`deep(store)` in an effect's compute phase subscribes to every nested property;
`snapshot(store)` gives the current plain value *without* subscribing.

## Async: the first-load model

`<Loading>` is the primary first-load model — the boundary owns branch readiness
and renders its fallback until the required reads settle. After content has
rendered, revalidation normally keeps the committed content visible.

Mapping from Solid 1 resource members:

| Solid 1 | Solid 2 |
| --- | --- |
| `resource.loading` | `<Loading>` for initial readiness; `isPending(() => resource())` for an in-flight *changed* answer |
| `resource.error` | `<Errored>` boundary or the effect `error` callback |
| `refetch()` | `refresh(resource)` |
| `mutate()` | an `action` plus `createOptimistic` / `createOptimisticStore` |
| `resource.latest` | `latest(resource)` |

`loadingValue` (and the store option `seedLoadingValue`) are advanced escape
hatches: a declared value prevents first-flight suspension and keeps `isPending`
false until the first real answer arrives. Only use them when provisional data
can render through the same UI as the final data; otherwise use `<Loading>`.

## Action rules

- An `action` is a generator or async generator and returns a promise.
- **Yield promises** to stay inside the action transaction. If an async
  generator uses `await` for a typed result, add a bare `yield` before later
  writes to re-enter the transaction.
- **Never call `flush()` inside an action** — it drains the transaction step.
- Invoke actions from event handlers or other imperative scopes, never from a
  component body or a computation.
- Writes to ordinary signals/stores are held by the transaction; optimistic
  writes are visible immediately and revert to their derived/base value when the
  transaction settles.

## JSX forms removed beyond the cheatsheet list

- `/*@once*/` is gone. Keep values reactive, use DOM defaults such as
  `defaultValue` for initial state, or take a narrow snapshot with `untrack`.
- `createDynamic(source, props)` → `dynamic(source)`.
- `<Errored>`'s function fallback receives an error **accessor** — read it as
  `error()`.
- Delegated events are now scoped to each render root and disposed with that
  root. The document-global `clearDelegatedEvents` API is removed. Rendering
  into nested roots, ShadowRoots or portals deserves integration testing.

## More removals, by intent

| Removed | Use instead |
| --- | --- |
| `createDeferred` | move the scheduling policy outside Solid |
| `createSelector` | `createProjection` or function-form `createStore` |
| `from` / `observable` | async iterables inbound; a split effect outbound. No direct Observable adapter. |
| `enableScheduling`, `writeSignal` | remove; internal/obsolete |
| `resetErrorBoundaries` | boundaries recover via current graph state or an explicit reset callback |

Undocumented Solid 1 imports (compiler, renderer, devtools, metaframework hooks)
may have **no** application-level replacement. Treat those as host-integration
work and check the owning package source.

## Testing

- Compile tests with the renderer's JSX runtime, and resolve the **browser** and
  **development** package conditions so tests exercise `@solidjs/web` rather
  than the server entry. (See Part 3 — this bit us.)
- `flush()` after effect creation before asserting the apply callback ran, and
  after setters before asserting values, effects, or DOM.
- Prefer `await user.click(...)` in user-level tests — the event tooling drains
  its own event sequence.
- `await resolve(() => value())` when a test must wait for a reactive expression
  to settle. Await action calls before asserting committed/reverted state.
- Test initial `Loading` fallback, settled content, revalidation pending state,
  and the error boundary as **separate** states.
- Run tests in development mode so the diagnostics fire, and fix them rather
  than suppressing them.

## SSR (for reference — we are client-only for now)

`renderToString` is synchronous and renders `Loading` fallbacks for unresolved
reads. `renderToStream` emits the shell then resolved fragments; use exactly one
consumer (`pipe`, `pipeTo`, or `readable`). `renderToStringAsync` is replaced by
`await renderToStream(...)`. Resources take `ssrSource` (default `"server"`,
adopting the serialized server result) and `deferStream` options.

---

# Part 3 — Our verification notes

Notes from actually installing the RC and running code, 2026-08-14, session
112-bad. **Kept separate from Parts 1–2 on purpose** so the provenance stays
clean; we fold confirmed items into Part 1 later.

Probe setup was a throwaway project: `bun add solid-js@next @solidjs/web@next`,
which resolved to `solid-js@2.0.0-rc.0` and `@solidjs/web@2.0.0-rc.0`.

## Confirmed

- **The shipped cheatsheet is the best source.** `node_modules/solid-js/CHEATSHEET.md`
  (Part 1 here) is not published on the docs site and is not linked from it. It
  is more direct than the website for codegen purposes, and it is versioned with
  the package. Re-read it on every `solid-js` upgrade.
- **`v2.solidjs.com` serves markdown**: append `.md` to any page URL. All 141
  pages are in `sitemap.xml`. Far better than scraping the HTML, which comes out
  full of Tailwind class-name garbage inlined into the prose.
- **Store draft setters work as documented.** `setStore(draft => { draft.user.city = "Paris"; draft.todos.push(2) })`
  followed by `flush()` produced `"Paris"` and length 2.
- **Prerelease tracks are genuinely mixed** (checked via `npm view <pkg> dist-tags`):
  `solid-js` and `@solidjs/web` at `2.0.0-rc.0`, but `@solidjs/router` at
  `2.0.0-next.16`, `@solidjs/vite-plugin` at `3.0.0-next.28`, `@solidjs/meta` at
  `1.0.0-next.2`, `@solidjs/start` at `2.0.0-rc.10`. Do not assume a single tag
  spans the platform.

## Gotcha: you will silently get the *server* build

This cost real time and would silently break any test suite.

`solid-js`'s `package.json` sets `"main": "./dist/server.cjs"` and
`"module": "./dist/server.js"`. The client build is reachable only through the
`browser` (and `development`) export conditions. So a plain `bun script.ts` — or
any test runner not configured with those conditions — loads the **server**
runtime.

On the server build, reactivity appears to be broken rather than absent:

```
memo run          # computes exactly once
d= 0
setC(5); flush()
d= 0  c= 5        # memo never recomputes, effect apply never fires
```

Same file with `bun --conditions browser --conditions development`:

```
memo run 0
effect d = 0
setC(5)
memo run 5
effect d = 10     # correct
```

The migration guide does say to "resolve the browser and development package
conditions" for tests, but it does not warn that failing to do so yields silent
non-reactivity rather than an error. If Solid ever looks fundamentally broken,
**check the resolved condition first.**

For Bun, the conditions can also be set in `bunfig.toml`; for Vitest, via
`resolve.conditions`. To be settled when we set up the real project.

## Open questions — verify before relying on these

- **Immediate read after a setter.** Docs (Part 1 and Part 2) state
  `setCount(1); count()` returns the *previous* value until flush. On the
  **server** build we observed `count()` returning the **new** value `1`
  immediately. That is not a valid refutation, since the server build's
  scheduling is clearly different (see above) — but the client build's behaviour
  here was never tested. Verify on the browser build before writing code that
  depends on either reading.
- Whether `flush()` is needed as often as the docs imply in event handlers.
- The `@solidjs/vite-plugin@3.0.0-next.28` + `solid-js@2.0.0-rc.0` combination
  has not been built or run at all yet.
- Nothing about SSR, hydration, `action`, `createOptimistic*`, `<Loading>`,
  `<Errored>` or `<Reveal>` has been exercised. All of Part 1's async section is
  documentation-only for us so far.
