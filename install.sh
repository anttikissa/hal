#!/bin/bash
# Symlink ~/.local/bin/hal -> this repo's run script

set -e

HAL_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${HOME}/.local/bin"

mkdir -p "$BIN_DIR"
ln -sf "$HAL_DIR/run" "$BIN_DIR/hal"

echo "Linked $BIN_DIR/hal -> $HAL_DIR/run"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
	echo "NOTE: $BIN_DIR is not in your PATH. Add it to your shell profile, e.g.:"
	echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
