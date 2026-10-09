#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  printf '\nInstall Node.js 22 or newer from https://nodejs.org/ , then reopen this launcher.\n'
  exit 1
fi
exec node tools/launch.js
