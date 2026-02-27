#!/bin/bash
# Symlink ~/.local/bin/hal -> this repo's run script

set -e

HAL_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${HOME}/.local/bin"

mkdir -p "$BIN_DIR"
ln -sf "$HAL_DIR/run" "$BIN_DIR/hal"

echo "Linked $BIN_DIR/hal -> $HAL_DIR/run"

# Add ~/.local/bin to PATH in shell profiles if not already there
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
	LINE='export PATH="$HOME/.local/bin:$PATH"'

	for rc in "$HOME/.zshrc" "$HOME/.bash_profile"; do
		echo "" >> "$rc"
		echo "$LINE" >> "$rc"
		echo "Added PATH entry to $rc"
	done

	echo ""
	echo "Restart your shell or run:"
	echo "  $LINE"
fi

echo ""
echo "Try it now:"
echo "  cd ~/my-project; hal   # work on a project"
echo "  hal -s                 # work on hal itself"
