#!/usr/bin/env bash
# tsvc-log.sh — Shared logging for all TSVC scripts
# Source this file: source "$(dirname "$0")/tsvc-log.sh" "SCRIPT_NAME"
#
# Writes to tsvc/logs/tsvc-ops.log with timestamps and script names.
# Also echoes to stdout for exec capture.

TSVC_LOG_DIR="${WORKSPACE:-$HOME/.openclaw/workspace}/tsvc/logs"
TSVC_OPS_LOG="$TSVC_LOG_DIR/tsvc-ops.log"
TSVC_LOG_SCRIPT="${1:-unknown}"

mkdir -p "$TSVC_LOG_DIR"

tsvc_log() {
  local level="${1:-INFO}"
  shift
  local msg="$*"
  local ts
  ts=$(TZ=America/Los_Angeles date '+%Y-%m-%d %I:%M:%S %p PT')
  local line="[$ts] [$TSVC_LOG_SCRIPT] [$level] $msg"
  echo "$line" >> "$TSVC_OPS_LOG"
  echo "$line"
}
