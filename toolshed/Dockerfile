FROM denoland/deno:2.1.9

# Use a regular shell with built-in commands like `timeout`
SHELL ["/bin/bash", "-c"]

WORKDIR /app

# Create cache directories and set permissions before switching user
RUN mkdir -p /app/node_modules/.deno && \
    mkdir -p /app/cache && \
    mkdir -p /app/vendor/memory && \
    chown -R deno:deno /app

# Prefer not to run as root.
USER deno


# FIXME(jake): We need to sort out a better way to handle deno dependencies...
# NOTE(jake): We need to put memory in the vendor directory
# so that it can be used by the app.
COPY --chown=deno:deno ./vendor/memory /memory

# Then copy the rest of the app
COPY --chown=deno:deno . .

# Cache and warmup
RUN deno cache index.ts
RUN timeout 10s deno -A index.ts || [ $? -eq 124 ] || exit 1

EXPOSE 8000
CMD ["run", "-A", "index.ts"]