#!/bin/bash
# TSVC Setup Script
# Replaces all placeholders with your actual values.
#
# Usage:
#   cd skills-tsvc
#   bash setup.sh
#
# This will interactively ask for your values and update all files in-place.
# Run once after cloning the repo.

set -e

echo "╔══════════════════════════════════════════════════╗"
echo "║          TSVC — Setup & Configuration            ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "This script replaces placeholders with your actual values."
echo "Press Ctrl+C to cancel at any time."
echo ""

# --- Collect values ---

read -p "Your messaging sender ID (e.g. Telegram user ID): " SENDER_ID

if [ -z "$SENDER_ID" ]; then
  echo "Error: Sender ID is required."
  exit 1
fi

echo ""
echo "Values to apply:"
echo "  Sender ID: $SENDER_ID"
echo ""
read -p "Proceed? (y/N): " CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

# --- Apply replacements ---

echo ""
echo "Applying..."

count=0
while IFS= read -r -d '' file; do
  if grep -q "YOUR_SENDER_ID" "$file" 2>/dev/null; then
    sed -i "s/YOUR_SENDER_ID/$SENDER_ID/g" "$file"
    echo "  ✓ $(basename "$file")"
    count=$((count + 1))
  fi
done < <(find . -type f \( -name "*.md" -o -name "*.js" -o -name "*.sh" -o -name "*.py" -o -name "*.ts" \) -not -path './.git/*' -print0)

echo ""
echo "Done. Updated $count file(s)."
echo ""
echo "Next steps:"
echo "  1. Review the changes: git diff"
echo "  2. Copy src/ files to your agent workspace"
echo "  3. See docs/integration.md for platform-specific setup"
echo "  4. See template/ for non-OpenClaw adapters"
