# sshd for git over SSH.
#
# The Worker cannot speak SSH itself, so it forwards the raw TCP socket here.
# This image authenticates by public key against Gitflare's D1 (through the main
# Worker) and shells out to git, proxying the actual objects to Artifacts over
# HTTPS with a repo-scoped token.
#
# See ssh/README.md — this image is only built when GITFLARE_SSH_ENABLED=1.

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       openssh-server git ca-certificates curl jq \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /run/sshd

# Git access only: no shell, no TTY, no forwarding. A compromised key must not
# become a foothold in the container.
RUN useradd --create-home --shell /usr/bin/git-shell git

COPY sshd_config /etc/ssh/sshd_config
COPY authorized-keys-command.sh /usr/local/bin/gitflare-authorized-keys
COPY git-shell-wrapper.sh /usr/local/bin/gitflare-git-shell
COPY entrypoint.sh /usr/local/bin/gitflare-entrypoint

RUN chmod 0755 /usr/local/bin/gitflare-authorized-keys \
                /usr/local/bin/gitflare-git-shell \
                /usr/local/bin/gitflare-entrypoint \
  # sshd refuses to use an AuthorizedKeysCommand that is group- or world-writable,
  # or whose owner is not root.
  && chown root:root /usr/local/bin/gitflare-authorized-keys

EXPOSE 22

ENTRYPOINT ["/usr/local/bin/gitflare-entrypoint"]
