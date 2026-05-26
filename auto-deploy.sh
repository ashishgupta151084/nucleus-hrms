#!/bin/bash
# Nucleus HRMS — Manual Push Deploy
# Usage: Type 'push' when ready to deploy

PROJECT="/Users/ashish/Library/CloudStorage/GoogleDrive-ashishgupta151084@gmail.com/My Drive/Claude/Claude_Code/nucleus-hrms"

cd "$PROJECT"

echo "🚀 Nucleus HRMS Deploy Ready"
echo "📁 Project: $PROJECT"
echo ""
echo "Make your changes in VS Code, then type 'push' to deploy."
echo "Type 'status' to see pending changes."
echo "Type 'exit' to quit."
echo ""

while true; do
  read -p "nucleus-hrms > " cmd

  case "$cmd" in
    push)
      CHANGES=$(git status --porcelain)
      if [ -z "$CHANGES" ]; then
        echo "⚠️  No changes detected. Edit App.jsx first."
      else
        echo "📝 Changes found:"
        git status --short
        echo ""
        git pull origin main --rebase 2>/dev/null
        git add .
        git commit -m "Update $(date '+%Y-%m-%d %H:%M:%S')"
        git push origin main
        echo ""
        echo "✅ Pushed! Firebase deploying in ~2 mins."
        echo "🌐 Check: https://nucleus-hrms.web.app"
      fi
      ;;
    status)
      echo "📋 Pending changes:"
      git status --short
      if [ -z "$(git status --porcelain)" ]; then
        echo "  No changes."
      fi
      ;;
    exit|quit)
      echo "👋 Bye!"
      break
      ;;
    *)
      echo "Commands: push | status | exit"
      ;;
  esac
  echo ""
done
