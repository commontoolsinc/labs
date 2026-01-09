FROM ubuntu:24.04

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
    unzip \
    sudo \
    software-properties-common \
    less

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
    gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
    tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && apt-get install -y gh

# Node.js 24 (via Nodesource)
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs

# Deno (install globally to /usr/local with pinned version)
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s v2.6.4

# Helix editor (requires software-properties-common from base tools)
RUN add-apt-repository -y ppa:maveonair/helix-editor && \
    apt-get update && \
    apt-get install -y helix

# MyST Markdown (via npm to avoid Python PEP 668 issues)
RUN npm install -g mystmd

# Install Playwright browser and dependencies
RUN npx playwright install chrome && \
    npx playwright install-deps chrome

# Install Claude CLI and Codex globally (accessible to all users)
RUN npm install -g @anthropic-ai/claude-code && \
    npm install -g @openai/codex

# Create ralph user (with sudo privileges for development)
RUN useradd -m -s /bin/bash ralph && \
    echo "ralph ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Set up working directory with proper ownership
RUN mkdir -p /app && chown ralph:ralph /app
WORKDIR /app

# Create labs directory structure (will be mounted from host)
RUN mkdir -p /app/labs && \
    chown -R ralph:ralph /app/labs

# Copy the startup script from local directory
COPY --chown=ralph:ralph start-servers.sh /app/start-servers.sh
RUN chmod +x /app/start-servers.sh

# Switch to ralph user
USER ralph

# Add ralph scripts to PATH
ENV PATH="/app/labs/tools/ralph/bin:$PATH"

# Start servers in background, wait for mount to settle, run smoketest, then exit
# If you want to run ralph normally without the smoketest, then replace with:
# CMD ["/bin/sh", "-c", "/app/start-servers.sh & sleep infinity"]
# Note: Directories are pre-created by run_smoketest.sh to ensure correct ownership
CMD ["/bin/bash", "-c", "/app/start-servers.sh & sleep 5 && TIMEFORMAT='%R'; { time /app/labs/tools/ralph/bin/ralph-smoketest.sh > /app/smoketest/${RALPH_ID}/ralph.log 2>&1 ; } 2> /app/smoketest/${RALPH_ID}/TIMING_SECONDS.txt"]
