FROM denoland/deno:2.1.5

WORKDIR /app

# Create cache directories and set permissions before switching user
RUN mkdir -p /app/node_modules/.deno && \
    mkdir -p /app/cache && \
    mkdir -p /app/lookslike-highlevel-dist && \
    chown -R deno:deno /app

# Prefer not to run as root.
USER deno

# Copy the pre-built assets first
# COPY --chown=deno:deno lookslike-highlevel-dist /app/lookslike-highlevel-dist

# Then copy the rest of the app
COPY --chown=deno:deno . .

# Cache and warmup
RUN deno cache index.ts
RUN timeout 10s deno -A index.ts || [ $? -eq 124 ] || exit 1

EXPOSE 8000
CMD ["run", "-A", "index.ts"]