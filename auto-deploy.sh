#!/bin/bash
# Nucleus HRMS — Auto Watch & Deploy
# Run this once: it watches for file changes and auto-pushes to GitHub

PROJECT="/Users/ashish/Library/CloudStorage/GoogleDrive-ashishgupta151084@gmail.com/My Drive/Claude/Claude_Code/nucleus-hrms"

echo "🚀 Nucleus HRMS Auto-Deploy Started"
echo "📁 Watching: $PROJECT"
echo "Any file change → auto pushes to GitHub → auto deploys to Firebase"
echo "Press Ctrl+C to stop"
echo ""

cd "$PROJECT"

while true; do
  # Check for any changes
  CHANGES=$(git status --porcelain)
  
  if [ -n "$CHANGES" ]; then
    echo "📝 Changes detected at $(date '+%H:%M:%S')"
    echo "$CHANGES"
    
    # Wait 3 seconds to make sure file is fully saved
    sleep 3
    
    git add .
    git commit -m "Auto-update $(date '+%Y-%m-%d %H:%M:%S')"
    git push origin main
    
    echo "✅ Pushed to GitHub! Firebase will deploy in ~2 mins"
    echo ""
  fi
  
  # Check every 5 seconds
  sleep 5
done
