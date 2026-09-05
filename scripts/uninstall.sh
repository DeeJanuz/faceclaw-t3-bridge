#!/bin/zsh

set -euo pipefail
set +x
umask 077

SCRIPT_DIR="${0:A:h}"
source "$SCRIPT_DIR/lib/common.sh"

PURGE_SECRETS=false
REMOVE_TAILSCALE_SERVE=false

usage() {
  print -- "Usage: scripts/uninstall.sh [--purge-secrets] [--remove-tailscale-serve]"
}

while (( $# > 0 )); do
  case "$1" in
    --purge-secrets) PURGE_SECRETS=true ;;
    --remove-tailscale-serve) REMOVE_TAILSCALE_SERVE=true ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unsupported argument: $1" ;;
  esac
  shift
done

validate_install_targets

# Preflight every requested target before changing launchd, credentials, files,
# or Tailscale configuration.
if [[ -e "$LAUNCH_AGENT_PATH" ]]; then
  [[ -f "$LAUNCH_AGENT_PATH" && ! -L "$LAUNCH_AGENT_PATH" ]] || fail "Refusing to remove an unexpected LaunchAgent target."
fi
RUNTIME_DIR="$APP_SUPPORT_DIR/runtime"
if [[ -e "$RUNTIME_DIR" ]]; then
  [[ -d "$RUNTIME_DIR" && ! -L "$RUNTIME_DIR" ]] || fail "Refusing to remove an unexpected runtime target."
  [[ -d "$USER_HOME/.Trash" && ! -L "$USER_HOME/.Trash" ]] || fail "User Trash directory is unavailable. Runtime files were not changed."
fi

SERVE_PORT_STATE=""
if $REMOVE_TAILSCALE_SERVE; then
  [[ -f "$SERVICE_STATE_PATH" && ! -L "$SERVICE_STATE_PATH" ]] || fail "Deployment state is missing. Refusing to change Tailscale Serve configuration."
  HTTPS_PORT="$(/usr/bin/plutil -extract httpsPort raw -o - "$SERVICE_STATE_PATH" 2>/dev/null)" || fail "Deployment state has no HTTPS port."
  validate_port "$HTTPS_PORT" "stored HTTPS port"
  TAILSCALE="$(command_path tailscale || true)"
  [[ -n "$TAILSCALE" ]] || fail "Tailscale CLI is missing. The Serve handler was not changed."
  TAILSCALE_HOST="$(/usr/bin/plutil -extract host raw -o - "$SERVICE_STATE_PATH" 2>/dev/null)" || fail "Deployment state has no Tailscale host."
  BRIDGE_PORT="$(/usr/bin/plutil -extract bridgePort raw -o - "$SERVICE_STATE_PATH" 2>/dev/null)" || fail "Deployment state has no bridge port."
  validate_port "$BRIDGE_PORT" "stored bridge port"
  NODE_PATH="$(command_path node || true)"
  [[ -n "$NODE_PATH" ]] || fail "Node is missing. The Serve handler was not changed."
  SERVE_PORT_STATE="$("$TAILSCALE" serve status --json | "$NODE_PATH" "$SCRIPT_DIR/deployment-helpers.mjs" serve-port-state "$TAILSCALE_HOST" "$HTTPS_PORT" "$BRIDGE_PORT")"
  if [[ "$SERVE_PORT_STATE" != "ours" && "$SERVE_PORT_STATE" != "empty" ]]; then
    fail "The Tailscale Serve handler no longer matches this deployment. It was not changed."
  fi
fi

if launchctl_loaded; then
  /bin/launchctl bootout "$GUI_DOMAIN/$SERVICE_LABEL"
fi
if [[ -f "$LAUNCH_AGENT_PATH" ]]; then
  /bin/rm -f "$LAUNCH_AGENT_PATH"
fi

if [[ -d "$RUNTIME_DIR" ]]; then
  TRASH_HOLDER="$(/usr/bin/mktemp -d "$USER_HOME/.Trash/Even T3 Bridge runtime.XXXXXX")"
  /bin/mv "$RUNTIME_DIR" "$TRASH_HOLDER/runtime"
  note "Moved installed runtime files to Trash: $TRASH_HOLDER"
fi

if $PURGE_SECRETS; then
  [[ ! -e "$TOKEN_PATH" || -f "$TOKEN_PATH" ]] || fail "Credential target changed during uninstall."
  [[ ! -e "$PASSPHRASE_PATH" || -f "$PASSPHRASE_PATH" ]] || fail "Credential target changed during uninstall."
  /bin/rm -f "$TOKEN_PATH" "$PASSPHRASE_PATH"
  /usr/bin/rmdir "$CREDENTIAL_DIR" 2>/dev/null || true
  note "Removed the bridge token and pairing passphrase. Paired phones must pair again after reinstall."
else
  note "User credential files preserved. Use --purge-secrets to remove them."
fi

if $REMOVE_TAILSCALE_SERVE; then
  if [[ "$SERVE_PORT_STATE" == "ours" ]]; then
    "$TAILSCALE" serve "--https=$HTTPS_PORT" off
    note "Removed only the verified Tailscale Serve HTTPS handler on port $HTTPS_PORT."
  else
    note "Tailscale Serve handler was already absent."
  fi
  /bin/rm -f "$SERVICE_STATE_PATH"
else
  note "Tailscale Serve configuration and deployment state preserved. Use --remove-tailscale-serve to remove this app's HTTPS handler."
fi
note "LaunchAgent and installed runtime removed. Homebrew packages, logs, models, artifacts, and the repository remain installed."
