print_tap_summary() {
    local title=$1 status=$2 log=$3

    printf '\n--- %s | Docker Compose ---\n' "$title"
    if [[ -s $log ]]; then
        grep -E '^[[:space:]]*(ok|not ok) |^# (Freeze takeover:|Crash takeover:|All [0-9]+ (source records|valid critical observations)|pass |fail )' "$log" || true
    else
        printf 'Target suite did not produce any output.\n'
    fi
    if (( status == 0 )); then
        printf 'Run result: PASS\n'
    else
        printf 'Run result: FAIL (exit %s)\n' "$status"
    fi
}
