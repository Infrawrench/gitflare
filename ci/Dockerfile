# Base image for @cloudflare/sandbox. The tag must match the @cloudflare/sandbox
# version in package.json — the SDK talks to a control server baked into the image
# and the two are versioned together.
FROM docker.io/cloudflare/sandbox:0.12.1

# Toolchain available to every `ci.runner({ command })`. The base image already
# carries node, npm, bun, and git; add anything your pipelines shell out to here.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*

EXPOSE 3000
