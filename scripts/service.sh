#!/bin/zsh

set -euo pipefail
set +x
umask 077

SCRIPT_DIR="${0:A:h}"
source "$SCRIPT_DIR/lib/common.sh"

validate_install_targets

usage() {
  print -- "Usage: scripts/service.sh {start|stop|restart|status|logs}"
}

configured_bridge_port() {
  local bridge_port=8787
  if [[ -f "$SERVICE_STATE_PATH" && ! -L "$SERVICE_STATE_PATH" ]]; then
    local configured_port
    configured_port="$(/usr/bin/plutil -extract bridgePort raw -o - "$SERVICE_STATE_PATH" 2>/dev/null || true)"
    if [[ -n "$configured_port" ]]; then
      validate_port "$configured_port" "stored bridge port"
      bridge_port="$configured_port"
    fi
  fi
  print -- "$bridge_port"
}

[[ $# == 1 ]] || { usage; exit 2; }

case "$1" in
  start)
    [[ -f "$LAUNCH_AGENT_PATH" && ! -L "$LAUNCH_AGENT_PATH" ]] || fail "LaunchAgent is not installed. Run scripts/install.sh."
    bridge_port="$(configured_bridge_port)"
    port_state="$(bridge_port_owner_state "$bridge_port")"
    [[ "$port_state" == "free" || "$port_state" == "owned" ]] || fail "Bridge port $bridge_port is owned by a process outside this LaunchAgent. It was not changed."
    /bin/launchctl enable "$GUI_DOMAIN/$SERVICE_LABEL"
    if ! launchctl_loaded; then
      if ! /bin/launchctl bootstrap "$GUI_DOMAIN" "$LAUNCH_AGENT_PATH"; then
        /bin/launchctl disable "$GUI_DOMAIN/$SERVICE_LABEL"
        fail "LaunchAgent bootstrap failed. The service remains disabled and unloaded."
      fi
    fi
    /bin/launchctl kickstart -k "$GUI_DOMAIN/$SERVICE_LABEL"
    note "Bridge start requested."
    ;;
  stop)
    if launchctl_loaded; then
      bridge_port="$(configured_bridge_port)"
      /bin/launchctl disable "$GUI_DOMAIN/$SERVICE_LABEL"
      /bin/launchctl bootout "$GUI_DOMAIN/$SERVICE_LABEL"
      port_state="occupied"
      agent_unloaded=false
      for attempt in {1..20}; do
        port_state="$(bridge_port_owner_state "$bridge_port")"
        if ! launchctl_loaded; then agent_unloaded=true; else agent_unloaded=false; fi
        [[ "$port_state" == "free" && "$agent_unloaded" == true ]] && break
        /bin/sleep 0.25
      done
      [[ "$port_state" == "free" && "$agent_unloaded" == true ]] || fail "The LaunchAgent did not fully unload or release bridge port $bridge_port. No unknown process was killed."
      note "Bridge stopped, disabled, and unloaded."
    else
      note "Bridge is not loaded."
    fi
    ;;
  restart)
    [[ -f "$LAUNCH_AGENT_PATH" && ! -L "$LAUNCH_AGENT_PATH" ]] || fail "LaunchAgent is not installed. Run scripts/install.sh."
    bridge_port="$(configured_bridge_port)"
    port_state="$(bridge_port_owner_state "$bridge_port")"
    [[ "$port_state" == "free" || "$port_state" == "owned" ]] || fail "Bridge port $bridge_port is owned by a process outside this LaunchAgent. It was not changed."
    /bin/launchctl enable "$GUI_DOMAIN/$SERVICE_LABEL"
    if ! launchctl_loaded; then
      if ! /bin/launchctl bootstrap "$GUI_DOMAIN" "$LAUNCH_AGENT_PATH"; then
        /bin/launchctl disable "$GUI_DOMAIN/$SERVICE_LABEL"
        fail "LaunchAgent bootstrap failed. The service remains disabled and unloaded."
      fi
    fi
    /bin/launchctl kickstart -k "$GUI_DOMAIN/$SERVICE_LABEL"
    note "Bridge restart requested."
    ;;
  status)
    node_path="$(command_path node || true)"
    if launchctl_loaded; then
      if [[ -n "$node_path" ]]; then
        /bin/launchctl print "$GUI_DOMAIN/$SERVICE_LABEL" | "$node_path" "$SCRIPT_DIR/deployment-helpers.mjs" launchctl-status
      else
        note "LaunchAgent: loaded"
      fi
    else
      note "LaunchAgent: not loaded"
    fi
    bridge_port="$(configured_bridge_port)"
    if /usr/bin/curl --silent --show-error --fail --max-time 2 "http://127.0.0.1:${bridge_port}/health" >/dev/null 2>&1; then
      note "Bridge health: ok"
    else
      note "Bridge health: unavailable"
    fi
    if command_path tailscale >/dev/null && [[ -n "${node_path:-}" ]] && [[ -f "$SERVICE_STATE_PATH" && ! -L "$SERVICE_STATE_PATH" ]]; then
      configured_host="$(/usr/bin/plutil -extract host raw -o - "$SERVICE_STATE_PATH" 2>/dev/null || true)"
      configured_https_port="$(/usr/bin/plutil -extract httpsPort raw -o - "$SERVICE_STATE_PATH" 2>/dev/null || true)"
      if [[ -n "$configured_host" && -n "$configured_https_port" ]]; then
        validate_port "$configured_https_port" "stored HTTPS port"
        serve_state="$("$(command_path tailscale)" serve status --json 2>/dev/null | "$node_path" "$SCRIPT_DIR/deployment-helpers.mjs" serve-port-state "$configured_host" "$configured_https_port" "$bridge_port" 2>/dev/null || true)"
        case "$serve_state" in
          ours) note "Tailscale Serve: ok" ;;
          empty) note "Tailscale Serve: missing" ;;
          conflict) note "Tailscale Serve: conflict" ;;
          *) note "Tailscale Serve: unavailable" ;;
        esac
      else
        note "Tailscale Serve: deployment state invalid"
      fi
    else
      note "Tailscale Serve: unavailable"
    fi
    ;;
  logs)
    /usr/bin/tail -n 100 "$LOG_DIR/bridge.log" "$LOG_DIR/bridge.error.log"
    ;;
  *)
    usage
    exit 2
    ;;
esac
