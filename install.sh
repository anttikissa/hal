#!/bin/bash
set -e

HAL_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${HOME}/.local/bin"

# Install Bun if not present
if ! command -v bun &>/dev/null; then
	echo "Installing Bun..."
	curl -fsSL https://bun.sh/install | bash
	export BUN_INSTALL="$HOME/.bun"
	export PATH="$BUN_INSTALL/bin:$PATH"
fi

# Symlink hal into ~/.local/bin
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
