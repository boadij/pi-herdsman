#!/bin/sh
set -eu

PACKAGE=pi-herdsman
PI_PACKAGE=@earendil-works/pi-coding-agent
INSTALL_DIR="${HERDR_INSTALL_DIR:-$HOME/.local/bin}"

log() { printf '  > %s\n' "$1"; }
err() { printf '  x %s\n' "$1" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || err "requires '$1'"
}

package_field() {
  node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
let value = data;
for (const key of process.argv[2].split(".")) value = value?.[key];
if (typeof value !== "string" || value.length === 0) process.exit(1);
process.stdout.write(value);
' "$manifest" "$1"
}

current_version() {
  "$1" --version 2>/dev/null | awk '{ print $NF }'
}

main() {
  need curl
  need node
  need npm
  need awk
  need grep

  node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
' || err "requires Node >=22.19.0"

  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=macos ;;
    *) err "unsupported OS: $(uname -s)" ;;
  esac

  if [ "$os" = linux ] && [ "$(uname -o 2>/dev/null || true)" = Android ]; then
    err "Android/Termux is not supported by Herdr release binaries"
  fi

  case "$(uname -m)" in
    x86_64|amd64) arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) err "unsupported architecture: $(uname -m)" ;;
  esac
  target="${os}-${arch}"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  manifest="$tmp/package.json"

  log "resolving released Pi Herdsman stack"
  npm view "$PACKAGE@latest" --json > "$manifest" ||
    err "could not resolve $PACKAGE@latest from npm"

  herdsman_version="$(package_field version)" ||
    err "released package is missing its version"
  pi_version="$(package_field piHerdsman.runtime.pi)" ||
    err "$PACKAGE@$herdsman_version does not publish bootstrap runtime metadata"
  herdr_version="$(package_field piHerdsman.runtime.herdr.version)" ||
    err "$PACKAGE@$herdsman_version does not publish a Herdr runtime version"
  herdr_sha256="$(package_field "piHerdsman.runtime.herdr.sha256.$target")" ||
    err "$PACKAGE@$herdsman_version does not support $target"

  case "$pi_version:$herdr_version" in
    *[!0-9A-Za-z.+:-]*) err "released runtime metadata contains an invalid version" ;;
  esac
  [ "${#herdr_sha256}" -eq 64 ] ||
    err "released runtime metadata contains an invalid Herdr checksum for $target"
  printf '%s\n' "$herdr_sha256" | awk '/[^0-9A-Fa-f]/ { exit 1 }' ||
    err "released runtime metadata contains an invalid Herdr checksum for $target"

  if command -v pi >/dev/null 2>&1 && [ "$(current_version pi)" = "$pi_version" ]; then
    log "Pi $pi_version already installed"
  else
    log "installing Pi $pi_version"
    npm install -g --ignore-scripts "$PI_PACKAGE@$pi_version"
    [ "$(current_version pi)" = "$pi_version" ] ||
      err "Pi $pi_version was installed but is not the Pi resolved on PATH"
  fi

  if command -v herdr >/dev/null 2>&1 && [ "$(current_version herdr)" = "$herdr_version" ]; then
    log "Herdr $herdr_version already installed"
  else
    case "$target" in
      linux-x86_64) asset=herdr-linux-x86_64 ;;
      linux-aarch64) asset=herdr-linux-aarch64 ;;
      macos-x86_64) asset=herdr-macos-x86_64 ;;
      macos-aarch64) asset=herdr-macos-aarch64 ;;
    esac

    if command -v sha256sum >/dev/null 2>&1; then
      checksum=sha256sum
    elif command -v shasum >/dev/null 2>&1; then
      checksum=shasum
    elif command -v openssl >/dev/null 2>&1; then
      checksum=openssl
    else
      err "SHA-256 verification requires sha256sum, shasum, or openssl"
    fi

    log "installing Herdr $herdr_version"
    curl -fsSL --retry 3 --connect-timeout 10 --max-time 120 \
      "https://github.com/herdrdev/herdr/releases/download/v${herdr_version}/${asset}" \
      -o "$tmp/herdr"

    case "$checksum" in
      sha256sum) actual="$(sha256sum < "$tmp/herdr" | awk '{ print $1 }')" ;;
      shasum) actual="$(shasum -a 256 < "$tmp/herdr" | awk '{ print $1 }')" ;;
      openssl) actual="$(openssl dgst -sha256 < "$tmp/herdr" | awk '{ print $NF }')" ;;
    esac
    [ "$actual" = "$herdr_sha256" ] ||
      err "downloaded Herdr checksum did not match"

    mkdir -p "$INSTALL_DIR"
    mv "$tmp/herdr" "$INSTALL_DIR/herdr"
    chmod 0755 "$INSTALL_DIR/herdr"

    if ! command -v herdr >/dev/null 2>&1 ||
      [ "$(current_version herdr)" != "$herdr_version" ]; then
      err "Herdr $herdr_version was installed to $INSTALL_DIR/herdr but is not the Herdr resolved on PATH"
    fi
  fi

  if pi list --no-approve 2>/dev/null |
    awk '{ print $1 }' |
    grep -Fx "npm:$PACKAGE" >/dev/null 2>&1; then
    log "Pi Herdsman $herdsman_version already installed"
  else
    log "installing Pi Herdsman $herdsman_version"
    pi install "npm:$PACKAGE" --no-approve
  fi

  log "installing Herdr Pi integration"
  herdr integration install pi
  herdr integration status >/dev/null

  printf '\nPi Herdsman %s ready with Pi %s and Herdr %s.\n' \
    "$herdsman_version" "$pi_version" "$herdr_version"
}

main "$@"
