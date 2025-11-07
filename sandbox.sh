#!/bin/bash
# Sandbox management CLI
# Handles timeout management for sandbox containers

TIMEOUT_FILE="/vercel/.sandbox_timeout"
DEFAULT_TIMEOUT=300000  # 5 minutes in milliseconds

# Get current timestamp in milliseconds
get_timestamp_ms() {
  date +%s%3N 2>/dev/null || echo $(($(date +%s) * 1000))
}

# Read timeout data from file
read_timeout_data() {
  if [ ! -f "$TIMEOUT_FILE" ]; then
    return 1
  fi
  
  local content=$(cat "$TIMEOUT_FILE")
  START_TIMESTAMP=$(echo "$content" | cut -d: -f1)
  TIMEOUT_DURATION=$(echo "$content" | cut -d: -f2)
  
  if [ -z "$START_TIMESTAMP" ] || [ -z "$TIMEOUT_DURATION" ]; then
    return 1
  fi
  
  return 0
}

# Write timeout data to file
write_timeout_data() {
  local start_timestamp=$1
  local timeout_duration=$2
  echo "${start_timestamp}:${timeout_duration}" > "$TIMEOUT_FILE"
}

# Start command - main entrypoint
start_cmd() {
  # Get initial timeout from argument, env var, or default
  local initial_timeout=${1:-${SANDBOX_TIMEOUT_MS:-$DEFAULT_TIMEOUT}}
  local start_timestamp=$(get_timestamp_ms)
  
  # Always write initial timeout data with container's start timestamp
  # This ensures we use the container's clock, not the host's
  write_timeout_data "$start_timestamp" "$initial_timeout"
  
  echo "Sandbox started at $(date -d @$((start_timestamp / 1000)) 2>/dev/null || echo $start_timestamp) with timeout ${initial_timeout}ms"
  
  # Main monitoring loop
  while true; do
    if ! read_timeout_data; then
      echo "Warning: Timeout file not found or invalid, using default timeout"
      local elapsed=$((($(get_timestamp_ms) - start_timestamp) / 1000))
      if [ "$elapsed" -ge $((DEFAULT_TIMEOUT / 1000)) ]; then
        echo "Sandbox default timeout expired, shutting down..."
        exit 0
      fi
      sleep 1
      continue
    fi
    
    local current_timestamp=$(get_timestamp_ms)
    local elapsed=$((current_timestamp - START_TIMESTAMP))
    
    if [ "$elapsed" -ge "$TIMEOUT_DURATION" ]; then
      echo "Sandbox timeout expired (${TIMEOUT_DURATION}ms elapsed), shutting down..."
      exit 0
    fi
    
    sleep 1
  done
}

# Extend timeout command
extend_timeout_cmd() {
  local extend_duration=$1
  
  if [ -z "$extend_duration" ]; then
    echo "Error: extend-timeout requires a duration in milliseconds" >&2
    exit 1
  fi
  
  if ! read_timeout_data; then
    echo "Error: Timeout file not found or invalid. Cannot extend timeout." >&2
    exit 1
  fi
  
  local new_timeout=$((TIMEOUT_DURATION + extend_duration))
  write_timeout_data "$START_TIMESTAMP" "$new_timeout"
  
  echo "Timeout extended by ${extend_duration}ms. New timeout: ${new_timeout}ms"
}

# Main command dispatcher
case "${1:-start}" in
  start)
    shift
    start_cmd "$@"
    ;;
  extend-timeout)
    shift
    extend_timeout_cmd "$@"
    ;;
  *)
    echo "Usage: $0 {start [timeout_ms]|extend-timeout <duration_ms>}" >&2
    exit 1
    ;;
esac

