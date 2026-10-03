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
