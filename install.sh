#!/usr/bin/env bash
# Install the brotu CLI.
#
#   curl -fsSL https://raw.githubusercontent.com/Zorbi-Tech/brotu/main/install.sh | bash
#
# Prefers a GitHub-release binary (no Node). Falls back to npm / bun.
set -euo pipefail

REPO="Zorbi-Tech/brotu"
NPM_PKG="@brotu/cli"
BIN_NAME="brotu"

info() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "need '$1' on PATH"
}

os_arch() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    darwin) os="darwin" ;;
    linux) os="linux" ;;
    *) die "unsupported OS: $os (use npm i -g $NPM_PKG)" ;;
  esac
  case "$arch" in
    arm64 | aarch64) arch="arm64" ;;
    x86_64 | amd64) arch="x64" ;;
    *) die "unsupported arch: $arch (use npm i -g $NPM_PKG)" ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

install_dir() {
  if [ -n "${BROTU_INSTALL_DIR:-}" ]; then
    printf '%s' "$BROTU_INSTALL_DIR"
    return
  fi
  if [ -w /usr/local/bin ] 2>/dev/null; then
    printf '/usr/local/bin'
    return
  fi
  printf '%s/.local/bin' "${HOME:?}"
}

download_binary() {
  local target dest url
  target="$(os_arch)"
  dest="$1"
  url="https://github.com/${REPO}/releases/latest/download/${BIN_NAME}-${target}"

  need_cmd curl
  info "downloading ${BIN_NAME}-${target}"
  if ! curl -fsSL "$url" -o "$dest"; then
    rm -f "$dest"
    return 1
  fi
  # GitHub serves an HTML 404 page if the asset is missing.
  if head -c 16 "$dest" | grep -q '<!DOCTYPE\|<html'; then
    rm -f "$dest"
    return 1
  fi
  chmod +x "$dest"
}

install_via_npm() {
  if command -v bun >/dev/null 2>&1; then
    info "installing ${NPM_PKG} with bun"
    bun add -g "$NPM_PKG"
    return
  fi
  if command -v npm >/dev/null 2>&1; then
    info "installing ${NPM_PKG} with npm"
    npm i -g "$NPM_PKG"
    return
  fi
  return 1
}

main() {
  local dir tmp
  dir="$(install_dir)"
  mkdir -p "$dir"
  tmp="$(mktemp "${TMPDIR:-/tmp}/${BIN_NAME}.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT

  if download_binary "$tmp"; then
    mv "$tmp" "${dir}/${BIN_NAME}"
    trap - EXIT
    info "installed ${dir}/${BIN_NAME}"
  else
    warn "no release binary for this platform — falling back to npm"
    install_via_npm || die "could not install. install Node or Bun, then: npm i -g ${NPM_PKG}"
  fi

  if ! command -v "$BIN_NAME" >/dev/null 2>&1; then
    warn "${dir} is not on PATH. Add this to your shell rc:"
    printf '\n  export PATH="%s:$PATH"\n\n' "$dir"
  fi

  info "try: ${BIN_NAME} --help"
}

main "$@"
