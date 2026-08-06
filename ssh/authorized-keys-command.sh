#!/bin/sh
# Resolves an offered public key to a Gitflare user.
#
# sshd runs this on every connection with the key the client offered. Looking the
# key up live means revoking it in the UI takes effect immediately, with no file
# to regenerate and no container to redeploy.
#
# Called as: gitflare-authorized-keys <user> <key-type> <key-base64>
set -eu

KEY_TYPE="$2"
KEY_BODY="$3"

# Fail closed. Any error below exits non-zero with no output, which sshd reads as
# "no authorized keys" and rejects the login.
[ -n "${GITFLARE_URL:-}" ] || exit 1
[ -n "${INTERNAL_TOKEN:-}" ] || exit 1

RESPONSE="$(
  curl --silent --show-error --fail --max-time 5 \
    --header "Authorization: Bearer ${INTERNAL_TOKEN}" \
    --header 'Content-Type: application/json' \
    --data "$(jq -nc --arg t "$KEY_TYPE" --arg k "$KEY_BODY" '{keyType:$t,publicKey:$k}')" \
    "${GITFLARE_URL}/internal/ssh/authorized-key"
)" || exit 1

USER_ID="$(printf '%s' "$RESPONSE" | jq -r '.userId // empty')"
[ -n "$USER_ID" ] || exit 1

# The key's owner is pinned into the authorized_keys line via `environment=`, so
# the forced command knows who is connecting without trusting anything the
# client sends. Restrictions are repeated here because AuthorizedKeysCommand
# output takes precedence over some sshd_config defaults.
printf 'environment="GITFLARE_USER_ID=%s",restrict %s %s\n' "$USER_ID" "$KEY_TYPE" "$KEY_BODY"
