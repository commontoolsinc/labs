---
title: Installing Common Tools
short_title: Installing Common Tools
description: How to install the Common Tools runtime
subject: Tutorial
subtitle: How to install the Common Tools runtime
authors:
  - name: Ellyse Cedeno
    email: ellyse@common.tools
keywords: commontools, install
abstract: |
  In this section, we install the code and servers needed to run the Common Tools runtime locally.
---
## Install Common Tools

Getting the basic Common Tools runtime up and running locally consists of 4 steps
1. Install Deno
1. Get the code
1. Configure any AI or extra services you want to run locally
1. Run the servers (Toolshed and Shell)

We'll go over each of these steps.

## Install Deno

You can visit [Deno's website](https://docs.deno.com/runtime/getting_started/installation/) for more information about how to install Deno on your system.

::::{tab-set}
:::{tab-item} Mac
:sync: tab1
**Shell**
```bash
curl -fsSL https://deno.land/install.sh | sh
```

**Homebrew**

```bash
brew install deno
```

**MacPorts**

```bash
sudo port install deno
```
:::
:::{tab-item} Linux
:sync: tab2
**Shell**
```bash
curl -fsSL https://deno.land/install.sh | sh
```

**npm**

```bash
npm install -g deno
```

**Nix**

```bash
nix-shell -p deno
```
:::
:::{tab-item} Windows
:sync: tab3
You really expected us to have docs for programming on Windows? 😂

[WSL](https://learn.microsoft.com/en-us/windows/wsl/install) might be a good option.
::::

## Getting the Code
All the source code you need is available at
[https://github.com/commontoolsinc/labs.git](https://github.com/commontoolsinc/labs.git)

```
$ git clone https://github.com/commontoolsinc/labs.git
$ cd labs
```

## Configuration 
If you plan on running any of the API services that Toolshed supplies, set the
`API_URL` environment variable.
```
$ export API_URL="http://localhost:8000"
```

If you plan to run LLM calls, you will need to give Toolshed your API keys for the LLM services.
See `./packages/toolshed/env.ts` for a list of LLMs supported and their associated environment variables.
The current default LLM is Claude, therefore setting the Anthropic key is really the only
requirement.
```
$ export CTTS_AI_LLM_ANTHROPIC_API_KEY=<INSERT_YOUR_ANTHROPIC_KEY>
```

## Run the servers
You'll need to run two servers (at the same time). The first one is the backend server, Toolshed. The following command will run Toolshed on its default port 8000. Note: the previous exported environment variables are important only for Toolshed. So make sure they are set in this shell instance.
```
$ cd ./packages/toolshed
$ deno task dev
```

Next, is the front-end server, Shell. The following command will run Shell on its default port 5173.
```
$ cd ./packages/shell
$ deno task dev-local
```

Now the servers should be running and you can navigate to [http://localhost:5173/](http://localhost:5173/) to see a not-too-exciting-yet charm.

(deploy_charms)=
## How to deploy charms
To deploy your first charm, you will run the `ct` CLI tool.
You'll need to create an identity for yourself. Run the following command at the project root:
```
$ deno task ct id new > my.key
```
This will create a key for you. We'll refer to this in the next command which actually deploys a charm. We'll deploy the `counter.tsx` charm. You can explore other charms in the same directory.

```
$ deno task ct charm new --identity my.key --url http://localhost:8000/test_space ./packages/patterns/counter.tsx
Task ct ROOT=$(pwd) && cd $INIT_CWD && deno run --allow-net --allow-ffi --allow-read --allow-write --allow-env "$ROOT/packages/cli/mod.ts" "charm" "new" "--identity" "my.key" "--url" "http://localhost:8000/test_space" "./packages/patterns/counter.tsx"
Warning experimentalDecorators compiler option is deprecated and may be removed at any time
baedreihr5yyujte22cd7oogtqldt4miifj356zj7ivgk4eom264ldsu5pm
```

Notice the last line from the deploy output. This is the charm ID that you just deployed. We will use it to navigate to this charm.
Here is the URL; replace <CHARM_ID> with
  the value from your command output: `http://localhost:5173/test_space/<CHARM_ID>`

Notice the format. Port 5173 is the port number that the Shell process is listening on.
`test_space` is the SPACE that you are deploying to. You can think of it as a namespace for permissions.
Any SPACE that doesn't exist already is dynamically created when you visit it.
Lastly, we see the charm ID that was created when you deployed the charm.

:::{admonition} Don't forget!
You will need to run the `deno task ct charm new` command each time you want to deploy a new charm.

You will also need to keep the Toolshed and Shell servers running in order to run the deploy command and also to visit the charm on your browser.
:::

