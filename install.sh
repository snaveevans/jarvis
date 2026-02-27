#!/usr/bin/env bash
set -euo pipefail

# ─── Jarvis Installer ───────────────────────────────────────────────────────
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/snaveevans/jarvis/main/install.sh | bash
#
# Environment variables:
#   JARVIS_HOME   Override install location (default: ~/.jarvis)
# ─────────────────────────────────────────────────────────────────────────────

REPO_URL="https://github.com/snaveevans/jarvis.git"
INSTALL_DIR="${JARVIS_HOME:-$HOME/.jarvis}"

# ─── Helpers ─────────────────────────────────────────────────────────────────

info()  { printf '  \033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[1;33m!\033[0m %s\n' "$*" >&2; }
fail()  { printf '  \033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ─── Pre-flight checks ──────────────────────────────────────────────────────

info "Checking prerequisites..."

# Detect OS/arch
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin|Linux) ;;
  *) fail "Unsupported OS: $OS (only macOS and Linux are supported)" ;;
esac
ok "OS: $OS ($ARCH)"

# Require git
command -v git >/dev/null 2>&1 || fail "git is required but not found. Install it first."
ok "git: $(git --version | head -1)"

# Require npm
command -v npm >/dev/null 2>&1 || fail "npm is required but not found. Install Node.js 22+ first."
ok "npm: $(npm --version)"

# Require Node.js 22+
command -v node >/dev/null 2>&1 || fail "node is required but not found. Install Node.js 22+ first."
NODE_VERSION="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
  fail "Node.js 22+ is required (found v$NODE_VERSION)"
fi
ok "node: v$NODE_VERSION"

# ─── Check for existing installation ────────────────────────────────────────

if [ -d "$INSTALL_DIR" ]; then
  if [ -d "$INSTALL_DIR/.git" ]; then
    warn "Jarvis is already installed at $INSTALL_DIR"
    warn "Run 'jarvis update' to update, or remove it first with: rm -rf $INSTALL_DIR"
    exit 1
  else
    fail "$INSTALL_DIR exists but is not a git repo. Remove it first or choose a different JARVIS_HOME."
  fi
fi

# ─── Clone ───────────────────────────────────────────────────────────────────

info "Installing Jarvis to $INSTALL_DIR ..."
git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
ok "Cloned repository"

# ─── Install dependencies ───────────────────────────────────────────────────

info "Installing dependencies..."
cd "$INSTALL_DIR"
npm install --no-audit --no-fund
ok "Dependencies installed"

info "Building..."
npm run build
ok "Build complete"

# ─── Set up PATH ─────────────────────────────────────────────────────────────

PATH_ENTRY='export PATH="$HOME/.jarvis/bin:$PATH"'
SHELL_NAME="$(basename "${SHELL:-/bin/bash}")"
RC_FILE=""

case "$SHELL_NAME" in
  zsh)  RC_FILE="$HOME/.zshrc" ;;
  bash)
    if [ -f "$HOME/.bash_profile" ]; then
      RC_FILE="$HOME/.bash_profile"
    else
      RC_FILE="$HOME/.bashrc"
    fi
    ;;
esac

if [ -n "$RC_FILE" ]; then
  if ! grep -qF '.jarvis/bin' "$RC_FILE" 2>/dev/null; then
    printf '\n# Jarvis\n%s\n' "$PATH_ENTRY" >> "$RC_FILE"
    ok "Added PATH entry to $RC_FILE"
  else
    ok "PATH entry already exists in $RC_FILE"
  fi
else
  warn "Could not detect shell config file for '$SHELL_NAME'."
  warn "Add the following to your shell profile manually:"
  warn "  $PATH_ENTRY"
fi

# ─── Verify ──────────────────────────────────────────────────────────────────

# Use the installed binary directly (PATH may not be updated in this shell)
JARVIS_BIN="$INSTALL_DIR/bin/jarvis"
chmod +x "$JARVIS_BIN"
VERSION="$("$JARVIS_BIN" --version 2>/dev/null || echo "unknown")"
ok "Installed Jarvis $VERSION"

# ─── Done ────────────────────────────────────────────────────────────────────

printf '\n'
printf '  \033[1;32mJarvis installed successfully!\033[0m\n'
printf '\n'
printf '  Next steps:\n'
if [ -n "$RC_FILE" ]; then
  printf '    1. Restart your shell or run: source %s\n' "$RC_FILE"
else
  printf '    1. Add jarvis to your PATH (see above)\n'
fi
printf '    2. Run: jarvis --help\n'
printf '\n'
