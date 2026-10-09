#!/bin/sh
cd "$(dirname "$0")" || exit 1
if command -v node >/dev/null 2>&1; then
  node tools/launch.js
  status=$?
else
  printf '\nInstall Node.js 22 or newer from https://nodejs.org/ , then reopen this launcher.\n'
  status=1
fi
if [ "$status" -ne 0 ] && [ -t 0 ]; then
  printf '\nPress Enter to close. '
  read -r answer
fi
exit "$status"
