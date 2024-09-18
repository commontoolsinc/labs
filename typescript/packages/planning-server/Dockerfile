ARG DENO_VERSION=1.46.3

FROM denoland/deno:$DENO_VERSION

ARG PORT=8000

EXPOSE $PORT

WORKDIR /app

ADD . /app

RUN deno --version

RUN deno cache src/index.ts

CMD ["run", "--allow-net", "--allow-read", "--allow-env", "src/index.ts"]
