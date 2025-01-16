FROM denoland/deno:2.1.5

# The port that your application listens to.
EXPOSE 8000

WORKDIR /app

# Create cache directories and set permissions before switching user
RUN mkdir -p /app/node_modules/.deno && \
    mkdir -p /app/cache && \
    chown -R deno:deno /app

# Prefer not to run as root.
USER deno

# These steps will be re-run upon each file change in your working directory:
COPY --chown=deno:deno . .

# Compile the main app so that it doesn't need to be compiled each startup/entry.
RUN deno cache index.ts

# Warmup caches
RUN timeout 10s deno -A index.ts || [ $? -eq 124 ] || exit 1

CMD ["run", "-A", "index.ts"]