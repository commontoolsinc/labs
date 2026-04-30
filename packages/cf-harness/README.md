# @commonfabric/cf-harness

`cf-harness` is an in-house agent harness package for Common Fabric. It is being
built as a general Common Fabric agent runtime, with Loom as the first target
use case.

The package is intentionally early and experimental. It already has a real
execution core, a bounded prompt/tool loop, persistence, resumability, a thin
operator CLI, and the first pass of CFC-aware deny/recovery shaping.

## Why This Exists

Common Fabric needs an agent harness that can become CFC-aware without
retrofitting CFC semantics awkwardly onto a third-party runtime.

The current design direction is:

- `runner` owns authoritative CFC meaning
- `cf-harness` transports and respects those semantics
- lower layers such as the gVisor-backed sandbox enforce conservative mediation
- the harness itself stays mechanistic rather than asking models to make policy
  decisions

## Current Scope

What works today:

- shell-centric execution against the local `runsc-cfc` sandbox path
- default sandbox image aligned with the public CFC kitchen-sink image published
  from the sibling `gvisor` repo:
  - `us-docker.pkg.dev/commontools-core/common-fabric/sandbox-kitchensink:latest`
- built-in tools:
  - `bash`
  - `bash-no-sandbox` (provisional host shell for named subagent profiles only)
  - `read_file`
  - `write_file`
  - `delegate_task`
- whole-file replace/create plus append writes
- bounded OpenAI-compatible prompt/tool loop
- single-child subagent delegation with fresh child prompt context, explicit
  default/browser child profiles, retained child run references, and a sanitized
  summary/state return channel
- optional schema-validated subagent structured returns, with raw child return
  artifacts retained in the child run and open-ended strings linkified before
  the parent sees them
- persisted run state, transcript, Loom run manifests, capability snapshots, and
  tool outputs
- transcript-based resumability
- package-local operator CLI
- CFC mode plumbing with:
  - `disabled`
  - `observe`
  - `enforce-explicit`
  - `enforce-strict`
- default CFC mode aligned with the runner's permissive-if-absent
  `enforce-explicit` rollout behavior
- spec-aligned `PromptSlotBound` prompt-slot evidence
- Loom run manifest intake through `--run-manifest`
- first-pass policy events and deny/recovery behavior
- configurable gateway auth mode:
  - `bearer`
  - `none`

What is not done yet:

- real runner-driven CFC feedback integration
- richer opaque-handle/pass-through behavior outside schema-validated subagent
  returns
- first-class browser operation policy on top of the provisional browser
  subagent profile
- parallel child orchestration
- app UI event provenance
- streaming model responses
- richer mid-turn resumability

## Package Layout

- [src/config.ts](src/config.ts)
  - harness config, CFC mode resolution, gateway auth mode
- [src/engine.ts](src/engine.ts)
  - core execution engine, run state, tool execution
- [src/prompt-loop.ts](src/prompt-loop.ts)
  - bounded prompt/tool loop
- [src/cli.ts](src/cli.ts)
  - package-local operator CLI
- [src/artifacts.ts](src/artifacts.ts)
  - persisted run state, run manifest, transcript, capability snapshot, and tool
    output storage
- [src/contracts/](src/contracts/)
  - prompt-slot, run-manifest, observation, policy, run-report, subagent,
    transcript, and tool-result contracts
- [integration/](integration/)
  - environment-gated real `runsc-cfc` integration tests

## Commands

From [packages/cf-harness](.):

- `deno task help`
- `deno task run -- ...`
- `deno task test`
- `deno task test:integration`

## CLI Example

Standard bearer-auth mode:

```bash
cd packages/cf-harness
CF_HARNESS_API_KEY=... deno task run -- \
  --workspace ../.. \
  --prompt "Summarize the cf-harness package structure." \
  --print-transcript
```

No-auth gateway mode:

```bash
cd packages/cf-harness
deno task run -- \
  --workspace ../.. \
  --gateway-auth-mode none \
  --prompt "Summarize the cf-harness package structure." \
  --print-transcript
```

Loom-backed batch runs may also pass a retained manifest:

```bash
deno task run -- \
  --workspace /path/to/workspace \
  --gateway-auth-mode none \
  --run-manifest /path/to/loom-run-manifest.json \
  --prompt "Handle this Loom wish."
```

When constraining the parent tool surface to `delegate_task`, authorize the
child profile separately so the delegation policy transition is explicit:

```bash
deno task run -- \
  --workspace /path/to/workspace \
  --gateway-auth-mode none \
  --allow-tool delegate_task \
  --allow-subagent-profile default \
  --prompt "Delegate a focused inspection and summarize the result."
```

The provisional browser profile is the only CLI-supported path to
`bash-no-sandbox`. It gives the child a host shell so it can invoke
`agent-browser`, while the parent still receives only the normal sanitized
subagent result. The host shell is policy-restricted to `agent-browser`,
`agent-browser` discovery (`which agent-browser`, `command -v agent-browser`),
`pwd`, `ls`, and bounded workspace-local `find` commands:

```bash
deno task run -- \
  --workspace /path/to/workspace \
  --gateway-auth-mode none \
  --allow-tool delegate_task \
  --allow-subagent-profile browser \
  --prompt "Delegate browser inspection of the local app and summarize the result."
```

Programmatic `delegate_task` calls may include `returnSchema`, a JSON Schema
object or boolean. In that mode the child is required to return a single JSON
value. The harness validates it, stores the raw child return under the child
artifact root, and exposes `subagent.structuredReturn.value` to the parent with
free-form strings replaced by pass-through link objects:

```json
{
  "goal": "Assess the briefing and return only the decision facts.",
  "returnSchema": {
    "type": "object",
    "properties": {
      "approved": { "type": "boolean" },
      "status": { "type": "string", "enum": ["approved", "not_approved"] },
      "summary": { "type": "string" }
    },
    "required": ["approved", "status", "summary"],
    "additionalProperties": false
  }
}
```

Current caveat:

- the default gateway target is still the stage endpoint at
  [https://llm.stage.commontools.dev/](https://llm.stage.commontools.dev/)
- gateway auth defaults remain an ergonomics question:
  - standalone `cf-harness` still defaults to `bearer`
  - Loom's `cf-harness` adapter defaults to `none`
- confirm the intended gateway/auth mode for the environment you are testing
  against

## Testing

Unit/package tests:

```bash
cd packages/cf-harness
deno task test
```

Environment-gated integration tests:

```bash
cd packages/cf-harness
deno task test:integration
```

The integration suite requires a working local Docker + `runsc-cfc` environment.
By default it also uses the published kitchen-sink image above, unless you
override `CF_HARNESS_INTEGRATION_IMAGE`.

To also exercise a real host Fabric FUSE mount bind-mounted into the sandbox at
`/fabric`, start `cf fuse mount` separately and pass the mountpoint:

```bash
cd packages/cf-harness
CF_HARNESS_INTEGRATION_FABRIC_MOUNT=/tmp/cf deno task test:integration
```

That opt-in case verifies that cf-harness can navigate `/fabric` through
`runsc-cfc` and read the FUSE `.status` file. Without
`CF_HARNESS_INTEGRATION_FABRIC_MOUNT`, the Fabric mount case is skipped.

On Linux, Docker/runsc runs default to the host UID/GID. On macOS, the default
omits `--user` because Docker Desktop bind mounts may expose host files as
`root:root`, which prevents non-root container users from writing mounted Loom
workspaces. An explicit `containerUser` still overrides the platform default.

CFC sandbox result mediation requires the installed `runsc-cfc` runtime to use
the same host result directory that `cf-harness` reads. Configure runsc with
`--cfc-result-dir=/path/to/results`, then set
`CF_HARNESS_RUNSC_CFC_RESULT_DIR=/path/to/results` or pass `cfcResultDir` in the
explicit sandbox config.

CFC invocation context transport is similarly coordinated through a host sidecar
directory. Configure runsc with
`--cfc-invocation-context-dir=/path/to/invocations`, then set
`CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR=/path/to/invocations` or pass
`cfcInvocationContextDir` in the explicit sandbox config. `cf-harness` writes
`<containerID>.json` after `docker create` and before `docker start`; the
current payload is an audit/provenance context, not yet an argv/stdin/cwd/env
label enforcement contract.

On Docker Desktop for macOS, use the host path for `cf-harness` and the
`/host_mnt/...` projection for Docker's runtime args. The gVisor
`docker-desktop-cfc-setup` helper defaults to:

```bash
export CF_HARNESS_RUNSC_CFC_RESULT_DIR="$HOME/.local/share/runsc-cfc/cfc-results"
export CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR="$HOME/.local/share/runsc-cfc/cfc-invocations"
```

## Related Docs

- [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)
- [LOOM_MIGRATION_NOTES.md](docs/LOOM_MIGRATION_NOTES.md)
- [runner README](../runner/README.md)
- `specs/cfc/18-runtime-implementation-profiles.md` in the sibling `specs` repo
