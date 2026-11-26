#!/usr/bin/env bash
set -euo pipefail

REPO="PocketRisu/PocketRisu"
INSTALL_DIR="${RISU_INSTALL_DIR:-$HOME/pocketrisu}"
PORT="${PORT:-6001}"

info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$*"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*"; exit 1; }

# ── Prerequisites ──────────────────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || error "Node.js is not installed. Please install Node.js 22.12+ first: https://nodejs.org/"

NODE_VER=$(node -e 'console.log(process.versions.node)')
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VER" | cut -d. -f2)
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; }; then
    error "Node.js v$NODE_VER detected. v22.12.0+ is required."
fi

if ! command -v pnpm >/dev/null 2>&1; then
    info "Installing pnpm..."
    npm install -g pnpm
fi

command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || error "curl or wget is required."

# ── Fetch latest release ───────────────────────────────────────────────────────

info "Fetching latest release from GitHub..."
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    || wget -qO- "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null) \
    || error "Failed to fetch release info. Check your internet connection."

TAG=$(echo "$RELEASE_JSON" | grep -o '"tag_name":[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$TAG" ] || error "Could not determine latest version."
info "Latest version: $TAG"

# ── Download source archive ────────────────────────────────────────────────────

TARBALL_URL="https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz"
TMP_DIR=$(mktemp -d)
KEEP_DIR=""
trap 'rm -rf "$TMP_DIR"; if [ -n "$KEEP_DIR" ] && [ -d "$KEEP_DIR" ]; then warn "Your save/ and backups/ are kept in $KEEP_DIR"; fi' EXIT

info "Downloading $TAG..."
if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$TARBALL_URL" -o "$TMP_DIR/release.tar.gz"
else
    wget -qO "$TMP_DIR/release.tar.gz" "$TARBALL_URL"
fi

info "Extracting..."
tar -xzf "$TMP_DIR/release.tar.gz" -C "$TMP_DIR"
# Match both PocketRisu-* (current) and Risuai-NodeOnly-* (legacy repo name)
# in case an older script encounters a redirected source archive.
# Use find rather than ls: ls exits non-zero when one branch has no match,
# which `set -euo pipefail` would propagate and abort the script.
EXTRACTED_DIR=$(find "$TMP_DIR" -maxdepth 1 -type d \
    \( -name 'PocketRisu-*' -o -name 'Risuai-NodeOnly-*' \) \
    -print -quit)
[ -d "$EXTRACTED_DIR" ] || error "Extraction failed."

# ── Install ────────────────────────────────────────────────────────────────────

# User data waits here during a reinstall: next to the install (same disk, so
# the move is a rename), not in TMP_DIR, which the EXIT trap removes and with
# it the user's data whenever the script stopped before putting it back.
KEEP_PATH="$(dirname "$INSTALL_DIR")/.$(basename "$INSTALL_DIR")-reinstall-keep"
# An empty one holds nothing to restore (stopped before the first move or
# after the last): remove it so it does not block this run.
rmdir "$KEEP_PATH" 2>/dev/null || true

if [ -e "$KEEP_PATH" ]; then
    # Left by an interrupted install: put it into this one.
    if [ -d "$INSTALL_DIR" ]; then
        if [ -d "$INSTALL_DIR/save" ] || [ -d "$INSTALL_DIR/backups" ]; then
            error "$KEEP_PATH is left from an interrupted install, and $INSTALL_DIR has its own save/ or backups/ too. Keep the ones you want somewhere safe, remove $KEEP_PATH, run again, then move them back into $INSTALL_DIR."
        fi
        error "$KEEP_PATH holds the save/ and backups/ of an interrupted install. Remove $INSTALL_DIR, which has neither, then run again to restore them."
    fi
    KEEP_DIR="$KEEP_PATH"
    info "Found save/ and backups/ kept by an interrupted install; they will be restored."
elif [ -d "$INSTALL_DIR" ]; then
    warn "$INSTALL_DIR already exists."
    printf "Overwrite? (existing save/ and backups/ data will be preserved) [y/N]: "
    read -r answer
    [ "$answer" = "y" ] || [ "$answer" = "Y" ] || error "Aborted."

    KEEP_DIR="$KEEP_PATH"
    mkdir "$KEEP_DIR"
    if [ -d "$INSTALL_DIR/save" ]; then
        mv "$INSTALL_DIR/save" "$KEEP_DIR/save"
    fi
    if [ -d "$INSTALL_DIR/backups" ]; then
        mv "$INSTALL_DIR/backups" "$KEEP_DIR/backups"
    fi
    rm -rf "$INSTALL_DIR"
fi

mv "$EXTRACTED_DIR" "$INSTALL_DIR"

# Restore user data
if [ -n "$KEEP_DIR" ]; then
    if [ -d "$KEEP_DIR/save" ]; then
        mv "$KEEP_DIR/save" "$INSTALL_DIR/save"
        info "Restored existing save/ data."
    fi
    if [ -d "$KEEP_DIR/backups" ]; then
        mv "$KEEP_DIR/backups" "$INSTALL_DIR/backups"
        info "Restored existing backups/ data."
    fi
    # Everything is back; a stray file left in it must not stop the install.
    rmdir "$KEEP_DIR" 2>/dev/null || warn "Remove $KEEP_DIR before the next install (save/ and backups/ are already restored)."
    KEEP_DIR=""
fi

cd "$INSTALL_DIR"

info "Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

info "Building..."
NODE_OPTIONS="--max-old-space-size=4096" pnpm build

info "Removing dev dependencies..."
pnpm prune --prod

# Write version marker for update script
echo "$TAG" > "$INSTALL_DIR/.installed-version"

# ── Optional: install cloudflared for remote access ──────────────────────────
if ! command -v cloudflared >/dev/null 2>&1; then
    printf "Install cloudflared for remote access? [y/N]: "
    read -r cfanswer
    if [ "$cfanswer" = "y" ] || [ "$cfanswer" = "Y" ]; then
        CF_OS=$(uname -s | tr '[:upper:]' '[:lower:]')
        CF_ARCH_RAW=$(uname -m)
        case "$CF_ARCH_RAW" in
            x86_64)  CF_ARCH="amd64" ;;
            aarch64|arm64) CF_ARCH="arm64" ;;
            *) warn "Unsupported architecture $CF_ARCH_RAW for cloudflared. Skipping."; CF_ARCH="" ;;
        esac
        if [ -n "$CF_ARCH" ]; then
            CF_DEST="$INSTALL_DIR/bin/cloudflared"
            mkdir -p "$INSTALL_DIR/bin"
            if [ "$CF_OS" = "darwin" ]; then
                CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${CF_ARCH}.tgz"
                info "Installing cloudflared..."
                if curl -fsSL "$CF_URL" -o /tmp/cloudflared.tgz 2>/dev/null; then
                    tar -xzf /tmp/cloudflared.tgz -C "$INSTALL_DIR/bin/"
                    chmod +x "$CF_DEST"
                    rm -f /tmp/cloudflared.tgz
                    info "cloudflared installed successfully."
                else
                    warn "Failed to install cloudflared. Remote access feature will be unavailable."
                fi
            else
                CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}"
                info "Installing cloudflared..."
                if curl -fsSL "$CF_URL" -o "$CF_DEST" 2>/dev/null; then
                    chmod +x "$CF_DEST"
                    info "cloudflared installed successfully."
                else
                    warn "Failed to install cloudflared. Remote access feature will be unavailable."
                fi
            fi
        fi
    fi
fi

# ── Done ───────────────────────────────────────────────────────────────────────

info "Installation complete!"
echo ""
echo "  Start the server:"
echo "    cd $INSTALL_DIR && pnpm runserver"
echo ""
echo "  Then open http://localhost:$PORT in your browser."
echo ""
echo "  To update later:"
echo "    cd $INSTALL_DIR && ./update.sh"
echo ""
