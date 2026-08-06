#!/bin/sh
# The only command an SSH session may run.
#
# sshd sets SSH_ORIGINAL_COMMAND to whatever the client asked for. Git sends
# exactly one of two things; anything else is rejected rather than executed.
#
# Authorization happens here, not in sshd: the key identifies *who* is
# connecting, but only Gitflare knows whether they may read or write this repo.
set -eu

COMMAND="${SSH_ORIGINAL_COMMAND:-}"

if [ -z "$COMMAND" ]; then
  echo "Gitflare does not provide shell access." >&2
  exit 128
fi

# Split "git-upload-pack 'owner/repo.git'" into verb and path.
VERB="${COMMAND%% *}"
RAW_PATH="${COMMAND#* }"

case "$VERB" in
  git-upload-pack|git-upload-archive) SCOPE=read ;;
  git-receive-pack)                   SCOPE=write ;;
  *)
    echo "Unsupported command: $VERB" >&2
    exit 128
    ;;
esac

# Strip the quoting git applies, the leading slash, and the .git suffix.
REPO_PATH="$(printf '%s' "$RAW_PATH" | tr -d "'\"" | sed -e 's#^/##' -e 's#\.git$##')"

case "$REPO_PATH" in
  */*/*|*..*|"")
    echo "Invalid repository path." >&2
    exit 128
    ;;
esac

# Exchange the identity and repo for a short-lived, repo-scoped Artifacts token.
# The main Worker applies the same permission rules the web UI and HTTPS proxy
# use, so SSH cannot become a way around them.
RESPONSE="$(
  curl --silent --show-error --fail --max-time 10 \
    --header "Authorization: Bearer ${INTERNAL_TOKEN}" \
    --header 'Content-Type: application/json' \
    --data "$(jq -nc \
        --arg u "${GITFLARE_USER_ID:-}" \
        --arg r "$REPO_PATH" \
        --arg s "$SCOPE" \
        '{userId:$u,repo:$r,scope:$s}')" \
    "${GITFLARE_URL}/internal/ssh/authorize"
)" || {
  echo "Repository not found, or you do not have access." >&2
  exit 128
}

REMOTE="$(printf '%s' "$RESPONSE" | jq -r '.remote // empty')"
TOKEN="$(printf '%s' "$RESPONSE" | jq -r '.token // empty')"

if [ -z "$REMOTE" ] || [ -z "$TOKEN" ]; then
  echo "Repository not found, or you do not have access." >&2
  exit 128
fi

# Artifacts speaks git over HTTPS, so the SSH session is bridged to it with
# `git remote-https`. The token goes in a header rather than the URL, keeping it
# out of process listings and any logs that record the remote.
export GIT_PROTOCOL="${GIT_PROTOCOL:-version=2}"
exec git \
  -c "http.extraHeader=Authorization: Bearer ${TOKEN}" \
  "$VERB" "$REMOTE"
