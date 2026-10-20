#!/bin/sh
# Stop Pricewatch and remove it from login items. Your data/ folder is kept.
set -eu
LABEL=com.pricewatch
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Pricewatch stopped and removed. Your price history is still in the data/ folder."
