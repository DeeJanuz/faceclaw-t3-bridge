#!/bin/zsh

set -euo pipefail
set +x
umask 077

SERVICE_LABEL="com.daenonjanis.even-t3-bridge"
CURRENT_ACCOUNT="$(/usr/bin/id -un)"
USER_HOME="$(/usr/bin/dscl . -read "/Users/${CURRENT_ACCOUNT}" NFSHomeDirectory | /usr/bin/awk '{print $2}')"
APP_SUPPORT_DIR="${USER_HOME}/Library/Application Support/Even T3 Bridge"
CREDENTIAL_DIR="${APP_SUPPORT_DIR}/credentials"
TOKEN_PATH="${CREDENTIAL_DIR}/bridge-token"
PASSPHRASE_PATH="${CREDENTIAL_DIR}/pairing-passphrase"
LOG_DIR="${USER_HOME}/Library/Logs/Even T3 Bridge"
LAUNCH_AGENT_PATH="${USER_HOME}/Library/LaunchAgents/${SERVICE_LABEL}.plist"
SERVICE_STATE_PATH="${APP_SUPPORT_DIR}/deployment-state.json"
GUI_DOMAIN="gui/$(/usr/bin/id -u)"

fail() {
  print -u2 -- "$1"
  exit 1
}

note() {
  print -- "$1"
}

validate_port() {
  local value="$1"
  local name="$2"
  [[ "$value" == <-> ]] || fail "${name} must be an integer from 1 through 65535."
  (( value >= 1 && value <= 65535 )) || fail "${name} must be an integer from 1 through 65535."
}

validate_install_targets() {
  [[ "$(uname -s)" == "Darwin" ]] || fail "This deployment supports macOS only."
  [[ -n "$USER_HOME" && "$USER_HOME" == /* && "$USER_HOME" != "/" ]] || fail "Could not resolve a safe user home directory."
  [[ "$APP_SUPPORT_DIR" == "$USER_HOME/Library/Application Support/Even T3 Bridge" ]] || fail "Application Support target is invalid."
  [[ "$LAUNCH_AGENT_PATH" == "$USER_HOME/Library/LaunchAgents/$SERVICE_LABEL.plist" ]] || fail "LaunchAgent target is invalid."
  for target in "$APP_SUPPORT_DIR" "$LOG_DIR" "$LAUNCH_AGENT_PATH"; do
    [[ "$target" != *$'\n'* && "$target" != *$'\r'* ]] || fail "A deployment target contains invalid data."
  done
  [[ ! -L "$APP_SUPPORT_DIR" ]] || fail "Refusing a symlinked Application Support directory: $APP_SUPPORT_DIR"
  [[ ! -L "$USER_HOME/Library/LaunchAgents" ]] || fail "Refusing a symlinked LaunchAgents directory."
  for target in "$LOG_DIR" "$APP_SUPPORT_DIR/runtime" "$APP_SUPPORT_DIR/models" "$APP_SUPPORT_DIR/artifacts" "$CREDENTIAL_DIR" "$TOKEN_PATH" "$PASSPHRASE_PATH" "$SERVICE_STATE_PATH"; do
    [[ ! -L "$target" ]] || fail "Refusing a symlinked deployment target: $target"
  done
}

command_path() {
  command -v "$1" 2>/dev/null || return 1
}

secret_path() {
  case "$1" in
    token) print -- "$TOKEN_PATH" ;;
    passphrase) print -- "$PASSPHRASE_PATH" ;;
    *) fail "Unknown credential name." ;;
  esac
}

secret_has() {
  local target="$(secret_path "$1")"
  [[ -f "$target" && ! -L "$target" ]]
}

secret_read() {
  local target="$(secret_path "$1")"
  [[ -f "$target" && ! -L "$target" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$target")" == "$(/usr/bin/id -u)" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$target")" == "600" ]] || return 1
  /bin/cat "$target"
}

secret_store() {
  local name="$1"
  local secret="$2"
  local target="$(secret_path "$name")"
  /usr/bin/install -d -m 700 "$CREDENTIAL_DIR"
  local temporary="$(/usr/bin/mktemp "$CREDENTIAL_DIR/.credential.XXXXXX")"
  print -rn -- "$secret" > "$temporary"
  /bin/chmod 600 "$temporary"
  /bin/mv -f "$temporary" "$target"
}

launchctl_loaded() {
  /bin/launchctl print "$GUI_DOMAIN/$SERVICE_LABEL" >/dev/null 2>&1
}

pid_descends_from() {
  local current="$1"
  local ancestor="$2"
  local steps=0
  while (( current > 1 && steps < 64 )); do
    [[ "$current" == "$ancestor" ]] && return 0
    current="$(/bin/ps -o ppid= -p "$current" 2>/dev/null | /usr/bin/tr -d ' ')"
    [[ "$current" == <-> ]] || return 1
    (( steps += 1 ))
  done
  return 1
}

bridge_port_owner_state() {
  local port="$1"
  validate_port "$port" "bridge port"
  local listeners lsof_exit
  set +e
  listeners="$(/usr/sbin/lsof -nP -t "-iTCP:${port}" -sTCP:LISTEN 2>/dev/null)"
  lsof_exit=$?
  set -e
  (( lsof_exit == 0 || lsof_exit == 1 )) || fail "Could not inspect bridge port $port."
  [[ -n "$listeners" ]] || { print -- "free"; return; }
  launchctl_loaded || { print -- "occupied"; return; }
  local agent_pid
  agent_pid="$(/bin/launchctl print "$GUI_DOMAIN/$SERVICE_LABEL" | /usr/bin/awk '$1 == "pid" && $2 == "=" { print $3; exit }')"
  [[ "$agent_pid" == <-> ]] || { print -- "occupied"; return; }
  local listener
  for listener in ${(f)listeners}; do
    [[ "$listener" == <-> ]] || { print -- "occupied"; return; }
    pid_descends_from "$listener" "$agent_pid" || { print -- "occupied"; return; }
  done
  print -- "owned"
}
