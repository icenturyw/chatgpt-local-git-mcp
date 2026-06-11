#!/bin/bash
PORT=3000
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Stopping existing service on port $PORT..."
PID=$(lsof -ti :$PORT 2>/dev/null)
if [ -n "$PID" ]; then
    kill $PID
    sleep 2
    echo "Process $PID stopped."
else
    echo "No process found on port $PORT."
fi

echo "Starting chatgpt-local-git-mcp..."
cd "$SCRIPT_DIR"
if [ -f .env ]; then
    set -a; source .env; set +a
fi
nohup npm run dev > /tmp/chatgpt-local-git-mcp.log 2>&1 &
sleep 3

NEW_PID=$(lsof -ti :$PORT 2>/dev/null)
if [ -n "$NEW_PID" ]; then
    echo "Service started successfully! PID: $NEW_PID"
    echo "Log: /tmp/chatgpt-local-git-mcp.log"
else
    echo "Failed to start service. Check log: /tmp/chatgpt-local-git-mcp.log"
fi
