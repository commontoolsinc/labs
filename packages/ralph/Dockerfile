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

# Claude CLI (Claude Code)
RUN npm install -g @anthropic-ai/claude-code

# Codex CLI - AI coding assistant
RUN npm install -g @openai/codex

# Create ralph user (with sudo privileges for development)
RUN useradd -m -s /bin/bash ralph && \
    apt-get update && apt-get install -y sudo && \
    echo "ralph ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Deno (install globally)
RUN curl -fsSL https://deno.land/install.sh | sh -s -- --no-modify-path && \
    mv /root/.deno /opt/deno && \
    chmod -R 755 /opt/deno
ENV DENO_INSTALL="/opt/deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

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

# Install Playwright browser and dependencies
RUN npx playwright install chrome && \
    npx playwright install-deps chrome

# Set up working directory with proper ownership
RUN mkdir -p /app && chown ralph:ralph /app
WORKDIR /app

# Clone the Common Tools repository into labs subdirectory
RUN git clone https://github.com/commontoolsinc/labs.git /app/labs && \
    chown -R ralph:ralph /app/labs

# Copy and append DEPLOY.md to AGENTS.md
COPY --chown=ralph:ralph DEPLOY.md /tmp/DEPLOY.md
RUN cat /tmp/DEPLOY.md >> /app/labs/AGENTS.md && \
    rm /tmp/DEPLOY.md

# Copy the startup script from local directory
COPY --chown=ralph:ralph start-servers.sh /app/start-servers.sh
RUN chmod +x /app/start-servers.sh

# Switch to ralph user
USER ralph

# Configure Claude MCP server for ralph user
# --no-sandbox is required because Docker containers restrict namespace creation
RUN claude mcp add --scope user playwright npx "@playwright/mcp@latest" -- --headless --isolated --no-sandbox

# Start Common Tool servers
CMD ["/app/start-servers.sh"]
