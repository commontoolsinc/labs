FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Base tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    git \
    ripgrep \
    build-essential \
    ca-certificates \
    gnupg \
    lsb-release \
    unzip

# GitHub CLI
RUN type -p curl >/dev/null || (apt-get update && apt-get install -y curl) && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
    gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
    tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && apt-get install -y gh

# Tailscale official install script
RUN curl -fsSL https://tailscale.com/install.sh | sh

# Node.js 24 (via Nodesource)
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs

# Deno
RUN curl -fsSL https://deno.land/install.sh | sh

# Helix editor
# need to install add-apt-repository from
# software-properties-common package
RUN apt-get install -y --no-install-recommends software-properties-common 
RUN add-apt-repository -y ppa:maveonair/helix-editor && \
    apt-get update && \
    apt-get install helix

# MyST Markdown
RUN apt-get update && apt-get install -y python3-pip && \
    pip install mystmd

WORKDIR /app
COPY . /app

CMD ["/bin/bash"]
