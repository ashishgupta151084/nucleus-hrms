#!/bin/bash
# Nucleus HRMS — Auto Watch & Deploy
PROJECT="/Users/ashish/Library/CloudStorage/GoogleDrive-ashishgupta151084@gmail.com/My Drive/Claude/Claude_Code/nucleus-hrms"

echo "🚀 Nucleus HRMS Auto-Deploy Started"
echo "Watching for file changes..."
echo "Press Ctrl+C to stop"
echo ""

cd "$PROJECT"

# Pull latest first
git pull origin main --rebase 2>/dev/null

while true; do
  CHANGES=$(git status --porcelain)
  
  if [ -n "$CHANGES" ]; then
    echo "📝 Changes detected at $(date '+%H:%M:%S')"
    sleep 3
    git pull origin main --rebase 2>/dev/null
    git add .
    git commit -m "Auto-update $(date '+%Y-%m-%d %H:%M:%S')"
    git push origin main
    echo "✅ Pushed! Firebase deploying in ~2 mins"
    echo ""
  fi
  
  sleep 5
done
