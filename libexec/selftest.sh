#!/bin/bash
# Probe commands for `dsh-airlock --selftest`. Runs inside the same sandbox
# profile and environment as a normal dsh-airlock run, so every result here is
# what the agent's own shell commands would get. Prints one line per probe and
# exits non-zero if any result differs from the expected one. Probes never print
# file contents, and any probe file they manage to create is removed again.
#
# Extra read probes: list absolute paths in $BOX/selftest-probes (default
# ~/.dsh-airlock/selftest-probes), one per line, for files you want proof the
# agent cannot read, such as a cloud credentials file.
REAL_HOME="$1"; WS="$2"; BOX="$3"
fails=0

report() { # expected actual label
  local mark="ok  "
  if [ "$1" != "$2" ]; then mark="FAIL"; fails=$((fails + 1)); fi
  printf '%s  %-8s %s\n' "$mark" "$2" "$3"
}

read_probe() { # expected path label
  if [ ! -e "$2" ]; then printf 'skip  %-8s %s (not present)\n' "-" "$3"; return; fi
  if [ -d "$2" ]; then ls "$2" >/dev/null 2>&1; else head -c 1 "$2" >/dev/null 2>&1; fi
  if [ $? -eq 0 ]; then report "$1" allowed "$3"; else report "$1" blocked "$3"; fi
}

write_probe() { # expected path label
  local existed=0
  [ -e "$2" ] && existed=1
  if { : >> "$2"; } 2>/dev/null; then
    report "$1" allowed "$3"
    [ "$existed" -eq 0 ] && rm -f "$2"
  else
    report "$1" blocked "$3"
  fi
}

run_probe() { # expected label command...
  local expected="$1" label="$2"; shift 2
  if "$@" >/dev/null 2>&1; then report "$expected" allowed "$label"; else report "$expected" blocked "$label"; fi
}

echo "Reads"
read_probe blocked "$REAL_HOME" "home folder listing"
read_probe blocked "$REAL_HOME/.ssh" "~/.ssh"
read_probe blocked "$REAL_HOME/.aws" "~/.aws"
read_probe blocked "$REAL_HOME/.config" "~/.config"
read_probe blocked "$REAL_HOME/.gitconfig" "~/.gitconfig"
read_probe blocked "$REAL_HOME/.zsh_history" "~/.zsh_history"
read_probe blocked "$REAL_HOME/Desktop" "Desktop"
read_probe blocked "$REAL_HOME/Documents" "Documents"
read_probe blocked "$REAL_HOME/Downloads" "Downloads"
read_probe blocked "$REAL_HOME/Library/Keychains" "keychain files"
read_probe blocked "$REAL_HOME/Library/CloudStorage" "cloud storage (OneDrive, Google Drive)"
read_probe blocked "$REAL_HOME/Library/Application Support" "app data"
read_probe blocked "$REAL_HOME/Library/Mail" "Mail"
read_probe blocked "/private/tmp" "/private/tmp"
read_probe blocked "$(getconf DARWIN_USER_TEMP_DIR)" "user temp folder"
if [ -f "$BOX/selftest-probes" ]; then
  while IFS= read -r extra; do
    case "$extra" in /*) read_probe blocked "$extra" "extra: $extra" ;; esac
  done < "$BOX/selftest-probes"
fi
read_probe allowed "$WS" "workspace"
read_probe allowed "$BOX/.gitconfig" "sandbox home"

echo "Writes"
write_probe blocked "$REAL_HOME/.dsh-airlock-selftest-probe" "home folder"
write_probe blocked "$REAL_HOME/Documents/.dsh-airlock-selftest-probe" "Documents"
write_probe blocked "/private/tmp/.dsh-airlock-selftest-probe" "/private/tmp"
write_probe allowed "$WS/.dsh-airlock-selftest-probe" "workspace"
write_probe allowed "$BOX/tmp/.dsh-airlock-selftest-probe" "sandbox temp"
write_probe blocked "$BOX/.dsh/.credentials.yaml" "dsh key file"
write_probe blocked "$BOX/.dsh/.env" "stored secrets (.env)"
write_probe blocked "$BOX/.dsh/cordis.patch.yml" "airlock settings layer"
write_probe blocked "$BOX/airlock.conf" "airlock search settings"
write_probe blocked "$BOX/.dsh/profiles/web/cordis.patch.yml" "Settings page layer"
write_probe blocked "$BOX/.dsh/AGENTS.md" "global instructions"
write_probe blocked "$WS/.env" "workspace .env"
renameprobe() { mv "$WS" "$WS.selftest-moved" 2>/dev/null || return 1; mv "$WS.selftest-moved" "$WS"; return 0; }
run_probe blocked "rename the workspace" renameprobe

echo "Escapes"
run_probe blocked "open (launch apps)" /usr/bin/open -g -a TextEdit
run_probe blocked "osascript (AppleScript)" /usr/bin/osascript -e 1
run_probe blocked "security (keychain tool)" /usr/bin/security list-keychains
run_probe blocked "screencapture" /usr/sbin/screencapture -x "$BOX/tmp/selftest.png"
rm -f "$BOX/tmp/selftest.png"
run_probe blocked "clipboard (pbpaste)" /usr/bin/pbpaste
if [ -n "$(/usr/bin/defaults read -g AppleLocale 2>/dev/null)" ]; then report blocked allowed "other apps' preferences"; else report blocked blocked "other apps' preferences"; fi

echo "Still works"
if /usr/bin/xcode-select -p >/dev/null 2>&1; then
  gitprobe() { local d="$BOX/tmp/gitprobe.$$"; git init -q "$d" && git -C "$d" status --porcelain >/dev/null; local rc=$?; rm -rf "$d"; return $rc; }
  run_probe allowed "git" gitprobe
else
  printf 'skip  %-8s %s (no Command Line Tools)\n' "-" "git"
fi
run_probe allowed "node" node -e '1'
run_probe allowed "https (registry.npmjs.org)" /usr/bin/curl -s -o /dev/null --max-time 15 https://registry.npmjs.org/

echo
if [ "$fails" -eq 0 ]; then echo "selftest: all probes as expected"; else echo "selftest: $fails probe(s) not as expected"; fi
exit "$fails"
