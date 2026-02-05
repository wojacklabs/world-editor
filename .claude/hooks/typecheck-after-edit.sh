#!/bin/bash
# Post-Edit hook: typecheck only .ts/.tsx files
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only check TypeScript files
if [[ "$FILE_PATH" == *.ts || "$FILE_PATH" == *.tsx ]]; then
  cd "$(dirname "$FILE_PATH")"
  # Find project root (where tsconfig.json is)
  while [[ ! -f "tsconfig.json" && "$PWD" != "/" ]]; do
    cd ..
  done

  if [[ -f "tsconfig.json" ]]; then
    OUTPUT=$(npx tsc --noEmit 2>&1)
    EXIT_CODE=$?
    if [[ $EXIT_CODE -ne 0 ]]; then
      echo "TypeScript errors found:"
      echo "$OUTPUT" | head -20
      exit 2  # Exit 2 = block and show error to Claude
    fi
  fi
fi

exit 0
