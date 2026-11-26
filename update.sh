#!/usr/bin/env bash
set -euo pipefail

REPO="PocketRisu/PocketRisu"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$*"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*"; exit 1; }

# ── Check current version ─────────────────────────────────────────────────────

CURRENT=""
if [ -f .installed-version ]; then
    CURRENT=$(cat .installed-version)
fi

if [ -z "$CURRENT" ]; then
    # Fallback: read from package.json
    CURRENT="v$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")"
fi

info "Current version: $CURRENT"

# ── Fetch latest release ───────────────────────────────────────────────────────

info "Checking for updates..."
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    || wget -qO- "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null) \
    || error "Failed to fetch release info."

LATEST=$(echo "$RELEASE_JSON" | grep -o '"tag_name":[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$LATEST" ] || error "Could not determine latest version."

if [ "$CURRENT" = "$LATEST" ]; then
    info "Already up to date ($CURRENT)."
    exit 0
fi

info "New version available: $LATEST"

# ── Confirm ────────────────────────────────────────────────────────────────────

printf "Update from %s to %s? [Y/n]: " "$CURRENT" "$LATEST"
read -r answer
[ "$answer" = "n" ] || [ "$answer" = "N" ] && { info "Aborted."; exit 0; }

# save/ is never touched below, so it is not copied: putting an early copy
# back at the end dropped whatever a running server wrote in the meantime.
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

# ── Download and extract ───────────────────────────────────────────────────────

TARBALL_URL="https://github.com/$REPO/archive/refs/tags/$LATEST.tar.gz"

info "Downloading $LATEST..."
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

# The certificate folder is not in the package: carry it into the new server/
# before the old one is removed (the in-app updater does the same).
SSL_CERT_DIR="server/node/ssl/certificate"
if [ -d "$SCRIPT_DIR/$SSL_CERT_DIR" ]; then
    info "Keeping SSL certificates..."
    mkdir -p "$EXTRACTED_DIR/server/node/ssl"
    cp -Rp "$SCRIPT_DIR/$SSL_CERT_DIR" "$EXTRACTED_DIR/server/node/ssl/"
fi

# ── Replace files (preserve save/ and user files) ──────────────────────────────

info "Updating files..."

# Only entries the app shipped may be removed: entries present in the new
# package, plus entries recorded in .installed-manifest (shipped by a previous
# release but since removed). Anything else is a user file — leave it alone.
MANIFEST_FILE="$SCRIPT_DIR/.installed-manifest"
is_managed() {
    [ -e "$EXTRACTED_DIR/$1" ] && return 0
    in_manifest "$1" && return 0
    return 1
}
in_manifest() {
    [ -f "$MANIFEST_FILE" ] && grep -Fxq "$1" "$MANIFEST_FILE"
}
# A user file whose name collides with an entry the new release introduces
# would be overwritten below — evacuate it to backups/ instead of losing it.
# Only decidable when a previous manifest exists.
CONFLICT_DIR="$SCRIPT_DIR/backups/update-conflict-$LATEST"

# Capture the new package's top-level listing before entries are moved out
ls -A "$EXTRACTED_DIR" > "$TMP_DIR/new-manifest"

while IFS= read -r -d '' entry; do
    name=$(basename "$entry")
    case "$name" in
        save|backups|.installed-version|.installed-manifest) continue ;;
    esac
    if ! is_managed "$name"; then
        info "Preserving user file: $name"
        continue
    fi
    if [ -f "$MANIFEST_FILE" ] && ! in_manifest "$name" && [ -e "$EXTRACTED_DIR/$name" ]; then
        warn "User file \"$name\" collides with a new app file — moving it to backups/update-conflict-$LATEST/"
        mkdir -p "$CONFLICT_DIR"
        # A retried update may have evacuated the same name before — never overwrite
        dest="$CONFLICT_DIR/$name"
        i=1
        while [ -e "$dest" ]; do dest="$CONFLICT_DIR/$name.$i"; i=$((i+1)); done
        mv "$entry" "$dest"
        continue
    fi
    rm -rf "$entry"
done < <(find "$SCRIPT_DIR" -mindepth 1 -maxdepth 1 -print0)

# Move new files in
mv "$EXTRACTED_DIR"/* "$EXTRACTED_DIR"/.[!.]* "$SCRIPT_DIR/" 2>/dev/null || true

# Record what this release shipped for the next update's managed-entry check
cp "$TMP_DIR/new-manifest" "$MANIFEST_FILE"

# ── Rebuild ────────────────────────────────────────────────────────────────────

info "Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

info "Building..."
NODE_OPTIONS="--max-old-space-size=4096" pnpm build

info "Removing dev dependencies..."
pnpm prune --prod

echo "$LATEST" > "$SCRIPT_DIR/.installed-version"

info "Update complete! $CURRENT → $LATEST"
echo ""
echo "  Restart the server to apply the update:"
echo "    pnpm runserver"
echo ""
