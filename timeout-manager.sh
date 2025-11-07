#!/bin/bash
# Timeout manager for sandbox containers
# Monitors /vercel/.timeout_timestamp and exits when the timeout expires

TIMEOUT_FILE="/vercel/.timeout_timestamp"
DEFAULT_TIMEOUT=300  # 5 minutes in seconds
START_TIME=$(date +%s)

# Monitor the timeout
while true; do
  CURRENT_TS=$(date +%s)
  
  if [ -f "$TIMEOUT_FILE" ]; then
    # File exists, use its timeout
    TIMEOUT_TS=$(cat "$TIMEOUT_FILE")
    
    if [ "$CURRENT_TS" -ge "$TIMEOUT_TS" ]; then
      echo "Sandbox timeout expired, shutting down..."
      exit 0
    fi
  else
    # File doesn't exist yet, use default timeout
    ELAPSED=$((CURRENT_TS - START_TIME))
    
    if [ "$ELAPSED" -ge "$DEFAULT_TIMEOUT" ]; then
      echo "Sandbox default timeout expired (no timeout file found), shutting down..."
      exit 0
    fi
  fi
  
  sleep 1
done

