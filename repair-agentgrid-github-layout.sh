#!/usr/bin/env bash
set -euo pipefail

# Run this script from the root of a local clone of AMARXAN/AgentGridWebsite.
# It repairs the flattened file layout in the current GitHub main snapshot.

if [[ ! -d .git ]]; then
  echo "ERROR: Run this script from the root of a Git clone (the .git directory is missing)." >&2
  exit 2
fi

move_tracked() {
  local from="$1" to="$2"
  if [[ -e "$from" ]]; then
    if [[ -e "$to" ]]; then
      echo "ERROR: Both '$from' and '$to' exist; refusing to overwrite either." >&2
      exit 3
    fi
    mkdir -p "$(dirname "$to")"
    git mv -- "$from" "$to"
    echo "Moved: $from -> $to"
  elif [[ -e "$to" ]]; then
    echo "Already in place: $to"
  else
    echo "ERROR: Neither '$from' nor '$to' exists." >&2
    exit 4
  fi
}

# Frontend files expected by index.html and tsconfig.app.json.
move_tracked App.tsx src/App.tsx
move_tracked main.tsx src/main.tsx
move_tracked styles.css src/styles.css

# Backend files must live together because they use relative imports.
move_tracked index.mjs server/index.mjs
move_tracked auth.mjs server/auth.mjs
move_tracked agent.mjs server/agent.mjs
move_tracked auth.test.mjs server/auth.test.mjs
move_tracked agent.test.mjs server/agent.test.mjs
move_tracked integration.test.mjs server/integration.test.mjs
move_tracked backup-db.mjs scripts/backup-db.mjs

# Restore GitHub's special config directories and environment examples.
move_tracked ci.yml .github/workflows/ci.yml
move_tracked dependabot.yml .github/dependabot.yml
move_tracked env.example .env.example
move_tracked 'env (1).example' server/.env.example
move_tracked 'download (2)' .gitignore

# Uploaded archives do not belong in the deploy root; remove only these known duplicates.
for archive in 'AgentGridWebsite.zip' 'AgentGridWebsite (2).zip' 'download'; do
  if [[ -e "$archive" ]]; then
    git rm -- "$archive"
    echo "Removed misplaced upload artifact: $archive"
  fi
done

# Verify the paths consumed by the build and runtime.
required=(
  package.json index.html tsconfig.app.json vite.config.ts
  src/App.tsx src/main.tsx src/styles.css
  server/index.mjs server/auth.mjs server/agent.mjs
  server/auth.test.mjs server/agent.test.mjs server/integration.test.mjs
  scripts/backup-db.mjs .github/workflows/ci.yml .github/dependabot.yml
  .env.example server/.env.example .gitignore
)
for path in "${required[@]}"; do
  [[ -f "$path" ]] || { echo "ERROR: Required path missing after repair: $path" >&2; exit 5; }
done

git diff --cached --check
echo "Staged diff whitespace check: PASS"
git status --short
echo
echo "Layout repair complete. Review the staged moves/deletions, then run:"
echo "  npm install --no-audit --no-fund"
echo "  npm run typecheck"
echo "  REQUIRE_INTEGRATION_TESTS=true npm test"
echo "  npm run build"
echo "Do not deploy until all checks pass. Commit and push only after reviewing the diff."
