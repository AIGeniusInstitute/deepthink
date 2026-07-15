#!/bin/sh
# DeepThink Sandbox entry script.
# Two modes:
#   ENTRY_MODE=session  (default): container stays alive, host injects commands via `docker exec`
#   ENTRY_MODE=exec:    read code from stdin, execute once, exit
set -eu

ENTRY_MODE="${ENTRY_MODE:-session}"
WORKDIR="${WORKDIR:-/workspace}"
mkdir -p "$WORKDIR"

if [ "$ENTRY_MODE" = "exec" ]; then
  LANG_CODE="${LANG_CODE:-python}"
  TIMEOUT_MS="${TIMEOUT_MS:-30000}"
  TIMEOUT_SEC=$((TIMEOUT_MS / 1000))

  # Read code from stdin into a file (tmpfs, isolated)
  CODE_FILE="$WORKDIR/code"
  cat > "$CODE_FILE"

  case "$LANG_CODE" in
    python)
      RUNNER="python3 -u"
      EXT="py"
      ;;
    node)
      RUNNER="node"
      EXT="js"
      ;;
    sh)
      RUNNER="sh"
      EXT="sh"
      ;;
    *)
      echo "UNSUPPORTED_LANG:$LANG_CODE" >&2
      exit 127
      ;;
  esac

  TARGET="$WORKDIR/code.$EXT"
  mv "$CODE_FILE" "$TARGET"

  # Hard wall-clock timeout; --preserve-status forwards the exit code
  timeout --preserve-status --signal=TERM "${TIMEOUT_SEC}s" $RUNNER "$TARGET"
  EXIT=$?
  echo "__SANDBOX_EXIT__:$EXIT"
  exit 0
fi

# session mode: stay alive so `docker exec` can inject commands
exec tail -f /dev/null
