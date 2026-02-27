#!/usr/bin/env bash
set -e

ASSUME_YES=false
[[ "${1:-}" == "-y" ]] && ASSUME_YES=true

HAL_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${HOME}/.local/bin"

ask() {
	if $ASSUME_YES; then return 0; fi
	read -rp "$1 [Y/n] " answer
	[[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}

# Install Bun if not present
if ! command -v bun &>/dev/null; then
	echo "Hal requires Bun (https://bun.sh)."
	if ask "I'd like to install Bun. Proceed?"; then
		curl -fsSL https://bun.sh/install | bash
		export BUN_INSTALL="$HOME/.bun"
		export PATH="$BUN_INSTALL/bin:$PATH"
	else
		echo "Bun is required. Install it manually and re-run this script."
		exit 1
	fi
fi

# Symlink hal into ~/.local/bin
mkdir -p "$BIN_DIR"
ln -sf "$HAL_DIR/run" "$BIN_DIR/hal"
echo "Linked $BIN_DIR/hal -> $HAL_DIR/run"

# Add ~/.local/bin to PATH in shell profiles if not already there
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
	LINE='export PATH="$HOME/.local/bin:$PATH"'

	for rc in "$HOME/.zshrc" "$HOME/.bash_profile"; do
		if ask "I'd like to add $BIN_DIR to your \$PATH by appending to $rc. Ok?"; then
			echo "" >> "$rc"
			echo "$LINE" >> "$rc"
			echo "  Added to $rc"
		fi
	done

	echo ""
	echo "Restart your shell or run:"
	echo "  $LINE"
fi

echo ""
echo "Try it now:"
echo "  cd ~/my-project; hal   # work on a project"
echo "  hal -s                 # work on hal itself"
