# README
Docker container to run the Common Tools servers

Ability to run [Ralph](https://ghuntley.com/ralph/)

Claude CLI and Codex are installed

## How to run Ralph

Running Docker locally (not pushing changes to repositories):
```bash
$ cd ./packages/ralph
$ docker build -t ralph .
$ docker run -d --name ralph ralph

```
Note for `docker build`:
* -t is for the tag, we use *ralph* here

Note for `docker run`:
* -d is for detached mode
* --name gives it an easier name to use for connecting to it later
* the last *ralph* referes to the build tag we used earlier

Connecting to the running container:
```bash
$ docker exec -it ralph bash
```
We are using the `--name ralph` we specified earlier to connect.

## Removing ralph
You must remove the existing version if you want to run a newer build:
```bash
$ docker stop ralph
$ docker rm ralph
```

## TODO
* add playwright with mcp
* Configure tailscale to start up
* push a working image to a docker hub
* update README to use image from dockerhub 
* DONE - Add codex and claude packages
* DONE - write section how to run ralph in this file
* DONE - git clone the common tools repositories
* DONE - start up toolshed server
* DONE - start up shell server
