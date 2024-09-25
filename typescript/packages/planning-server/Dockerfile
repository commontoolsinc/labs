ARG DENO_VERSION=1.46.3

FROM denoland/deno:$DENO_VERSION

ARG PORT=8000

EXPOSE $PORT

WORKDIR /app

ADD . /app

RUN deno --version

ARG TS_ENTRYPOINT=src/index.ts

RUN deno cache $TS_ENTRYPOINT

CMD ["run", "--allow-all", "${TS_ENTRYPOINT}"]
