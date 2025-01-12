# CLI

The main.ts file is a CLI that handles the instantiation of the app.

The CLI is used to start the hono app, queue workers, and performa handful of other tasks.

### Start

The start command is used to start the hono app. It will also start the queue workers, so we can run background tasks.

```
toolshed start

toolshed start --port 3001

PORT=3001 toolshed start
```

### Doctor

The doctor command is used to check the health of the app. It will verify that all of the necessary environment variables are set, and that the app configuration is all valid.

If the doctor command returns a failure, it will return a non-zero exit code, along with a list of issues that need to be addressed.

```
toolshed doctor
```

### Create User

The create user command is used to create a new user.

```
toolshed create-user --email=user@example.com
```

### Init

The init command will setup all of the local data persistence for the app.

```
toolshed init
```

### Reset

The reset command will remove all of the local data persistence for the app, giving you a fresh start.

```
toolshed reset
```
