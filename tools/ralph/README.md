# README

Docker container to run the Common Tools servers

Ability to run [Ralph](https://ghuntley.com/ralph/)

Claude CLI and Codex are installed

## How to run Ralph

### Using pre-built image from Docker Hub (recommended)

```bash
$ docker pull ellyxir/ralph
$ docker run -d --name ralph -p 8000:8000 ellyxir/ralph
```

To connect to the container (connecting as ralph user is recommended):

```bash
$ docker exec -it -u ralph ralph bash  # Connect as ralph user (recommended)
# OR
$ docker exec -it ralph bash           # Connect as root (if needed for admin tasks)
```

Once connected to the container, to use Ralph for automated pattern development:

```bash
# Navigate to labs directory
$ cd labs

# run claude once to set up to authenticate
$ claude

# Get latest changes
$ git pull

# Create a branch for your work
$ git checkout -b my-ralph-patterns
```

Edit `./tools/ralph/TASKS.md` with your tasks. Use indentation to show task
dependencies (children require parent completion). Add [UI] to indicate
UI-related tasks.

# Run Ralph to automatically implement the patterns

```bash
$ ralph-claude.sh
```

Ralph will work through eligible tasks, creating patterns in
`./tools/ralph/patterns/`. It commits working implementations and uses git stash
for anything that fails tests. Progress is logged to `./tools/ralph/logs/`.

## Building locally

If you want to build the image yourself with local modifications:

```bash
$ cd ./tools/ralph
$ docker build -t <user_name>/ralph .
$ docker run -d --name ralph -p 8000:8000 <user_name>/ralph
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

## Removing ralph container

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
- figure out how LLM tokens should be set for toolshed
- sandbox the container (network config)
