#!/bin/zsh

set -euo pipefail
set +x
umask 077

SCRIPT_DIR="${0:A:h}"
source "$SCRIPT_DIR/lib/common.sh"

validate_install_targets
[[ -x "${NODE_EXECUTABLE:-}" ]] || fail "Configured Node executable is missing. Run scripts/install.sh again."
[[ -f "$SCRIPT_DIR/../bridge/scripts/start-with-t3.mjs" ]] || fail "Bridge launcher is missing."

bridge_token="$(secret_read token)" || fail "Bridge token is missing from the user credential store. Run scripts/install.sh again."
bridge_passphrase="$(secret_read passphrase)" || fail "Pairing passphrase is missing from the user credential store. Run scripts/install.sh again."

[[ "$bridge_token" != *[^A-Za-z0-9_-]* && ${#bridge_token} -ge 32 && ${#bridge_token} -le 256 ]] || fail "Stored bridge token is invalid."
[[ ${#bridge_passphrase} -ge 12 && ${#bridge_passphrase} -le 256 ]] || fail "Stored pairing passphrase is invalid."
[[ "$bridge_passphrase" != *$'\n'* && "$bridge_passphrase" != *$'\r'* ]] || fail "Stored pairing passphrase is invalid."

export BRIDGE_TOKEN="$bridge_token"
export BRIDGE_PASSPHRASE="$bridge_passphrase"
unset bridge_token bridge_passphrase

cd "$SCRIPT_DIR/../bridge"
exec "$NODE_EXECUTABLE" "$SCRIPT_DIR/../bridge/scripts/start-with-t3.mjs"
