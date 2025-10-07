# README

Docker container to run the Common Tools servers

Ability to run [Ralph](https://ghuntley.com/ralph/)

Claude CLI and Codex are installed

## How to run Ralph

### Using pre-built image from Docker Hub (recommended)

```bash
$ docker pull ellyxir/ralph
$ docker run -d --name ralph -p 8000:8000 -p 5173:5173 ellyxir/ralph
```

To connect to the container (connecting as ralph user is recommended):

```bash
$ docker exec -it -u ralph ralph bash  # Connect as ralph user (recommended)
# OR
$ docker exec -it ralph bash           # Connect as root (if needed for admin tasks)
```

### Building locally

If you want to build the image yourself with local modifications:

```bash
$ cd ./tools/ralph
$ docker build -t <user_name>/ralph .
$ docker run -d --name ralph -p 8000:8000 -p 5173:5173 <user_name>/ralph
```

Note for `docker build`:

- -t is for the tag, we use _ralph_ here

Note for `docker run`:

- -d is for detached mode
- --name gives it an easier name to use for connecting to it later
- the last _<user_name>/ralph_ referes to the build tag we used earlier

Connecting to the running container:

```bash
$ docker exec -it -u ralph ralph bash  # Connect as ralph user (recommended)
$ docker exec -it ralph bash
```

We are using the `--name ralph` we specified earlier to connect.

Running Claude Code with all permissions:

```bash
$ claude --dangerously-skip-permissions
```

## Removing ralph

You must remove the existing version if you want to run a newer build:

```bash
$ docker stop ralph
$ docker rm ralph
```

## Pushing new image to Dockerhub

```
$ docker login
$ docker push <user_name>/ralph
```

## TODO

- add playwright to codex
- configure tailscale to start up
- push a working image to a docker hub
- update README to use image from dockerhub
- figure out how LLM tokens should be set for toolshed
- sandbox the container (network config)
- make ralph easy to run
- DONE - change permissions so claude auto updater will work
- DONE - move ralph script into ./tools/ralph
- DONE - Add codex and claude packages
- DONE - write section how to run ralph in this file
- DONE - git clone the common tools repositories
- DONE - start up toolshed server
- DONE - start up shell server
- DONE - add playwright mcp to claude
  - created ralph user since chrome doesnt like to run as root, probably better
    this way anyway
  - made ralph sudoer
