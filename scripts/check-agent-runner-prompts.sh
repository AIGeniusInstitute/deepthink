#!/usr/bin/env bash
# Verify that all prompt files referenced from agent-runner source code actually exist.
#
# Background: agent-runner loads `.md` prompt files at module-load time (readFileSync).
# If src references a file that no longer exists in container/agent-runner/prompts/,
# the container crashes at startup with `ENOENT '/tmp/prompts/<name>.md'` — but only
# when the container actually runs. This check moves the failure earlier, into typecheck.
#
# Covered call patterns:
#   loadPrompt('foo.md')                — single-arg helper
#   loadPrompt('seg', 'foo.md')         — multi-segment helper (last arg is the file)
#   path.join(..., 'prompts', 'foo.md') — path.join literal
#   'prompts/foo.md' / "prompts/foo.md" — direct concatenation
#
# Style aligned with scripts/check-stream-event-sync.sh: pure bash + grep -E, no python3.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT/container/agent-runner/src"
PROMPTS_DIR="$ROOT/container/agent-runner/prompts"

if [ ! -d "$SRC_DIR" ]; then
  echo "ERROR: agent-runner src dir not found: $SRC_DIR"
  exit 1
fi

if [ ! -d "$PROMPTS_DIR" ]; then
  echo "ERROR: agent-runner prompts dir not found: $PROMPTS_DIR"
  exit 1
fi

# Collect all .ts files under src/.
TS_FILES=()
while IFS= read -r -d '' f; do
  TS_FILES+=("$f")
done < <(find "$SRC_DIR" -type f -name '*.ts' -print0)

if [ "${#TS_FILES[@]}" -eq 0 ]; then
  echo "ERROR: no .ts files found under $SRC_DIR"
  exit 1
fi

# Match patterns and capture the .md filename.
# We emit each hit as: <abs-file>:<line>:<filename.md>
#
# Patterns (each emits one occurrence per line):
#   1) loadPrompt(...,  'foo.md')   — captures the LAST quoted .md token before ')'
#   2) 'prompts', 'foo.md'           — path.join-style literal pair
#   3) 'prompts/foo.md'              — slash-form direct literal
HITS_FILE="$(mktemp)"
trap 'rm -f "$HITS_FILE"' EXIT

# Pattern 1: loadPrompt(...) — pull the final quoted .md arg before the closing paren.
#            Works for loadPrompt('foo.md') and loadPrompt('seg', 'foo.md').
grep -HnE "loadPrompt\([^)]*\.md['\"]\)" "${TS_FILES[@]}" 2>/dev/null \
  | sed -nE "s/.*loadPrompt\([^)]*['\"]([a-zA-Z0-9_.-]+\.md)['\"]\).*/&/p" \
  | sed -nE "s/^([^:]+):([0-9]+):.*loadPrompt\([^)]*['\"]([a-zA-Z0-9_.-]+\.md)['\"]\).*$/\1:\2:\3/p" \
  >> "$HITS_FILE" || true

# Pattern 2: 'prompts', 'foo.md' or "prompts", "foo.md" (path.join-style)
grep -HnE "['\"]prompts['\"][[:space:]]*,[[:space:]]*['\"][a-zA-Z0-9_.-]+\.md['\"]" "${TS_FILES[@]}" 2>/dev/null \
  | sed -nE "s/^([^:]+):([0-9]+):.*['\"]prompts['\"][[:space:]]*,[[:space:]]*['\"]([a-zA-Z0-9_.-]+\.md)['\"].*$/\1:\2:\3/p" \
  >> "$HITS_FILE" || true

# Pattern 3: 'prompts/foo.md' direct
grep -HnE "['\"]prompts/[a-zA-Z0-9_.-]+\.md['\"]" "${TS_FILES[@]}" 2>/dev/null \
  | sed -nE "s/^([^:]+):([0-9]+):.*['\"]prompts\/([a-zA-Z0-9_.-]+\.md)['\"].*$/\1:\2:\3/p" \
  >> "$HITS_FILE" || true

# Sort + uniq by (file, line, filename) tuple.
sort -u -o "$HITS_FILE" "$HITS_FILE"

HIT_COUNT=$(wc -l < "$HITS_FILE" | tr -d ' ')

# Sanity check: if the regex matched 0 references but src/ clearly contains 'prompts',
# that's almost certainly a regex bug rather than "no prompts referenced".
if [ "$HIT_COUNT" -eq 0 ]; then
  if grep -lE "prompts" "${TS_FILES[@]}" >/dev/null 2>&1; then
    echo "✗ Suspicious: source contains 'prompts' but regex matched 0 references — possibly a regex bug"
    echo "  Files containing 'prompts':"
    grep -lE "prompts" "${TS_FILES[@]}" | sed 's/^/    /'
    exit 1
  fi
  echo "✓ No prompt-file references found in agent-runner src (prompts may be inlined)."
  exit 0
fi

# Walk through hits, check existence.
MISSING=0
declare -a UNIQUE_NAMES=()
while IFS=: read -r file line name; do
  if [ -z "$name" ]; then continue; fi
  if [ ! -f "$PROMPTS_DIR/$name" ]; then
    rel="${file#$ROOT/}"
    echo "Missing: prompts/$name (referenced in $rel:$line)"
    MISSING=$((MISSING + 1))
  fi
done < "$HITS_FILE"

if [ "$MISSING" -gt 0 ]; then
  echo ""
  echo "Container will fail to start with 'ENOENT /tmp/prompts/<name>.md' when it runs."
  echo "Either restore the missing files, or remove the references from src/."
  exit 1
fi

# Count unique referenced filenames for the success message.
UNIQUE_COUNT=$(awk -F: '{print $3}' "$HITS_FILE" | sort -u | wc -l | tr -d ' ')

echo "✓ All $UNIQUE_COUNT prompt references resolved"
awk -F: '{print $3}' "$HITS_FILE" | sort -u | sed 's/^/   - /'
