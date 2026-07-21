#!/bin/bash
# AUTO-COMMIT LOCAL — Runs daily via Windows Task Scheduler
# Commits and pushes any pending changes in mcl-wms repo
#
# Setup (run once in PowerShell as admin):
#   schtasks /create /tn "MCL-WMS Auto Commit" /tr "bash 'C:/Users/dgarc/Downloads/Agentes MCL/mcl-wms/scripts/auto-commit-local.sh'" /sc daily /st 23:55 /f
#
# Or manually: bash scripts/auto-commit-local.sh

REPO_DIR="C:/Users/dgarc/Downloads/Agentes MCL/mcl-wms"
cd "$REPO_DIR" || exit 1

# Check if there are any changes
git add -A
if git diff --cached --quiet; then
  echo "$(date): No changes to commit."
  exit 0
fi

# Show what we're committing
echo "$(date): Changes detected:"
git diff --cached --stat

# Commit
DATE=$(date -u +%Y-%m-%d)
git commit -m "AUTO — Commit diario de cambios locales ($DATE)"

# Push
git push origin master
echo "$(date): Commit and push complete."
