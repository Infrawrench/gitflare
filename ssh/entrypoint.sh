#!/bin/sh
# Installs the host key and starts sshd in the foreground.
#
# The host key is injected as a secret rather than generated at build or start
# time. A key generated per container would change whenever an instance is
# replaced, and every user would get the "REMOTE HOST IDENTIFICATION HAS
# CHANGED" warning — which trains people to ignore exactly the warning that
# matters.
set -eu

KEY_PATH=/etc/ssh/ssh_host_ed25519_key

if [ -z "${SSH_HOST_KEY:-}" ]; then
  echo "SSH_HOST_KEY is not set. Generate one with:" >&2
  echo "  ssh-keygen -t ed25519 -N '' -f gitflare_host_key" >&2
  echo "  wrangler secret put SSH_HOST_KEY --config wrangler.ssh.jsonc < gitflare_host_key" >&2
  exit 1
fi

printf '%s\n' "$SSH_HOST_KEY" > "$KEY_PATH"
chmod 0600 "$KEY_PATH"
chown root:root "$KEY_PATH"
ssh-keygen -y -f "$KEY_PATH" > "${KEY_PATH}.pub"

# -D keeps sshd in the foreground so the container runtime owns its lifecycle;
# -e sends logs to stderr where they are collected.
exec /usr/sbin/sshd -D -e
