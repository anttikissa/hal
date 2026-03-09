#!/bin/bash
set -euo pipefail

HAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HAL_DIR"

echo "=== Directory Switcheroo ==="
echo "HAL_DIR: $HAL_DIR"
echo

# Sanity checks
if [ ! -d "state" ]; then echo "ERROR: state/ not found"; exit 1; fi
if [ ! -d "new-state" ]; then echo "ERROR: new-state/ not found"; exit 1; fi
if [ -d "old-state" ]; then echo "ERROR: old-state/ already exists"; exit 1; fi
if [ -f "old-run" ]; then echo "ERROR: old-run already exists"; exit 1; fi

# Check no hal processes are running
if pgrep -f "bun main.ts" > /dev/null 2>&1; then
	echo "ERROR: hal processes still running. Close the app first."
	exit 1
fi

echo "1. state/ → old-state/"
mv state old-state

echo "2. new-state/ → state/"
mv new-state state

echo "3. run → old-run"
mv run old-run

echo "4. Updating old-run to default to old-state/"
sed -i '' 's|HAL_STATE_DIR:-\$HAL_DIR/state|HAL_STATE_DIR:-\$HAL_DIR/old-state|' old-run

echo "5. Updating old code (src/state.ts) to default to old-state/"
sed -i '' "s|\`\${HAL_DIR}/state\`|\`\${HAL_DIR}/old-state\`|" src/state.ts

echo "6. Writing new run script"
cat > run << 'SCRIPT'
#!/usr/bin/env bash

# Resolve symlinks so this works when invoked via ~/.local/bin/hal
SCRIPT_PATH="$0"
[[ -L "$SCRIPT_PATH" ]] && SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
export HAL_DIR="${HAL_DIR:-$(cd "$(dirname "$SCRIPT_PATH")" && pwd)}"
export LAUNCH_CWD="${LAUNCH_CWD:-$(pwd)}"
export HAL_STATE_DIR="${HAL_STATE_DIR:-$HAL_DIR/state}"
cd "$HAL_DIR" || exit 1

while true; do
	bun new/main.ts "$@"
	code=$?
	[ "$code" -ne 100 ] && exit "$code"
done
SCRIPT
chmod +x run
rm -f cli

echo "7. Updating new code (new/state.ts): NEW_STATE_DIR → HAL_STATE_DIR, default → state/"
sed -i '' 's/NEW_STATE_DIR/HAL_STATE_DIR/g' new/state.ts
sed -i '' "s|new-state|state|" new/state.ts
sed -i '' "s|hal-new-test-|hal-test-|" new/state.ts

echo "8. Updating tests: NEW_STATE_DIR → HAL_STATE_DIR"
sed -i '' 's/NEW_STATE_DIR/HAL_STATE_DIR/g' new/state.test.ts
sed -i '' 's/NEW_STATE_DIR/HAL_STATE_DIR/g' new/ipc.test.ts
sed -i '' "s|hal-new-test-|hal-test-|" new/state.test.ts

echo "9. Creating ~/.local/bin/old-hal → old-run"
ln -sf "$HAL_DIR/old-run" "$HOME/.local/bin/old-hal"

echo "10. Updating ~/.local/bin/hal → run"
ln -sf "$HAL_DIR/run" "$HOME/.local/bin/hal"

echo
echo "Done! Summary:"
echo "  hal     → run     → new code (new/main.ts), state in state/"
echo "  old-hal → old-run → old code (main.ts), state in old-state/"
echo
echo "Run 'hal' to start the new client."
