#!/usr/bin/env bash
set -uo pipefail

# Restart the hal web screen session on a remote box (kissa.dev layout: repo at
# /root/hal, ./run keeping it alive, secrets in /root/hal/.env-*). Sources the
# env files fresh on every start, so this is also how env changes get picked up.
# Kills any previous hal screen by name pattern; never touches other screens.

host=${1:-kissa.dev}

exec ssh "$host" '
	for old in $(screen -ls | awk "/\.hal[[:space:]]/ {print \$1}"); do
		screen -S "$old" -X quit
	done
	sleep 1
	screen -dmS hal -L -Logfile /root/hal-screen.log bash -c "
		cd /root/hal || exit 1
		set -a
		source ./.env-*
		set +a
		exec ./run
	"
	sleep 2
	if screen -ls | grep -q "\.hal"; then
		echo "hal restarted"
	else
		echo "failed to start; see /root/hal-screen.log"
		exit 1
	fi
'
