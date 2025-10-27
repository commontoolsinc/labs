# README

Docker container to run the Common Tools servers

Ability to run [Ralph](https://ghuntley.com/ralph/)

Claude CLI and Codex are installed

## How to use Smoketest Ralph

Smoketest Ralph runs a single task from `TASKS.md` and exits when complete. Each
Ralph instance is assigned a specific task via the `RALPH_ID` environment
variable.

### Running smoketests

**Option 1: Use the automated script (recommended)**

Run multiple smoketests in parallel (currently configured for tasks 1-8):

```bash
./tools/ralph/bin/run_smoketest.sh
```

This script will:

- Clean up old results
- Stop/remove any existing ralph containers
- Start smoketest containers in parallel (one per task)
- Results are written to `./tools/ralph/smoketest/<ID>/`

**Adding new tasks:** Edit `RALPH_IDS` variable at the top of
`tools/ralph/bin/run_smoketest.sh` to include new task numbers (e.g., change
`"1 2 3 4 5 6 7 8"` to `"1 2 3 4 5 6 7 8 9"`).

The containers use bind mounts, so any changes you make to PROMPTS will be
immediately available inside the running containers.

Monitor progress by checking the logs in the smoketest directory:

```bash
cat tools/ralph/smoketest/1/ralph.log  # or /2/, /3/
# Or follow live:
tail -f tools/ralph/smoketest/1/ralph.log
```

To stop all running smoketests:

```bash
./tools/ralph/bin/stop_smoketest.sh
```

**Option 2: Run a single smoketest manually**

1. Build the Docker image (if not using pre-built):

```bash
docker build -t ellyxir/ralph tools/ralph/
```

2. Run the container with your RALPH_ID and mounted credentials:

```bash
cd ~/labs
docker run -e RALPH_ID=3 -d -v ~/.claude.json:/home/ralph/.claude.json \
  -v ~/.claude/.credentials.json:/home/ralph/.claude/.credentials.json \
  -v ./tools/ralph/smoketest:/app/smoketest --name ralph ellyxir/ralph
```

Note: The container will exit automatically when the smoketest completes.

### Retrieving results

Results are available on the host machine in
`./tools/ralph/smoketest/${RALPH_ID}/`:

- `ralph.log` - Complete log of Ralph's execution (stdout and stderr)
- `SCORE.txt` - Contains SUCCESS, PARTIAL, or FAILURE
- `RESULTS.md` - Summary of work including test results
- Pattern files (created directly in this directory for automatic cleanup)

No need to copy files from the container - the bind mount makes results
immediately available on your host machine as Ralph works. Pattern files are
created directly in the smoketest directory (not in packages/patterns), so they
are automatically cleaned up when smoketests rerun.

## How to run Ralph (not smoketest)

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
