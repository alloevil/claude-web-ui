#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "=== Claude Code Web UI ==="
echo ""

# Install dependencies
echo "Installing dependencies..."
pip install -q -r requirements.txt 2>/dev/null || pip3 install -q -r requirements.txt

echo ""
echo "Starting server on http://localhost:8080"
echo "Press Ctrl+C to stop"
echo ""

python3 -m uvicorn server:app --reload --port 8080
