# Hal

This is HAL 9001, an agent harness.

![Hal in a terminal (left) and a web browser (right)](hal.png)

Goals:

- Lightweight and as few dependencies as possible.
- Minimal system prompt, minimal set of tools out of the box.
- Support for multiple Claude & ChatGPT subscriptions with account rotation, plus a few others
- Use native terminal features - stuff like cmd-click on links, scrolling, ctrl-c, ctrl-z, should *just work*.
- You can use shift to select text! Yes!
- Hackable: Hal can inspect and edit itself. Ctrl-R to restart and continue from where you left off.
- Run multiple sessions in tabs, which are persistent by default - pretty much like a web browser.
- Mac and Linux support (for now).
- Try to keep under 20k lines of code and startup time under 200ms even if you have 50 tabs open.

# Install

```
git clone https://github.com/anttikissa/hal ~/.hal
cd ~/.hal
# Hal uses Bun as its runtime; this installs it for you if you don't have it.
./install
# might have to restart shell for $PATH to update, then:
hal 
```

# Plugins

Hal has no plugin API in the usual sense. Each module exports one
mutable object and calls its own functions through it
(`models.resolve()`, not `resolve()`), so every function on every module
is a hook point. The surface is wide and shallow: wide because nothing
is off limits, shallow because functions are small and settings are
plain values on the same objects, so a plugin overrides exactly one
decision — which model `opus` means, how long a list stays cached —
without copying the code around it. A `plugins/*.ts` file in the Hal
home hooks functions with `before`, `after` or `around` and sets values
with `set`; Hal reloads it on save and removes exactly its overrides
when it changes, is deleted or expires.

The price of that width is stability: the surface is Hal's internals,
not a versioned contract, and names can change. To keep it navigable,
each module's top comment documents its plugin surface: what each
function decides, which ones are worth hooking, and what a hook must
preserve.
