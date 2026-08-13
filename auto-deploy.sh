#!/bin/bash
# Nucleus HRMS — Build & Deploy
# Type 'push' to build and deploy to Firebase

PROJECT="/Users/ashish/Library/CloudStorage/GoogleDrive-ashishgupta151084@gmail.com/My Drive/Claude/Claude_Code/nucleus-hrms"

cd "$PROJECT"

echo "🚀 Nucleus HRMS Deploy Ready"
echo "Make changes, then type 'push' to build & deploy."
echo "Type 'status' to see changed files."
echo "Type 'exit' to quit."
echo ""

while true; do
  read -p "nucleus-hrms > " cmd

  case "$cmd" in
    push)
      echo "🔨 Building..."
      BUILD_OUTPUT=$(npm run build 2>&1)
      if echo "$BUILD_OUTPUT" | grep -q "built in"; then
        echo "✅ Build successful!"
        echo ""
        echo "🚀 Deploying to Firebase..."
        firebase deploy --only hosting
        echo ""
        echo "🌐 Live at: https://nucleus-hrms.web.app"
      else
        echo "❌ Build failed! Error:"
        echo "$BUILD_OUTPUT" | grep -A5 "error"
        echo ""
        echo "Fix the error and try push again."
      fi
      ;;
    status)
      echo "📋 Changed files:"
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
