# @commonfabric/cf-harness

`cf-harness` is an in-house agent harness package for Common Fabric. It is being
built as a general Common Fabric agent runtime, with Loom as the first target
use case.

The package is intentionally early and experimental. It already has a real
execution core, a bounded prompt/tool loop, persistence, resumability, a thin
operator CLI, explicit Agent Skills preload, and the first pass of CFC-aware
deny/recovery shaping.

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
- sandbox containers default to Docker `--network bridge` so local Loom/Fabric
  helper services can be reached through Docker Desktop's `host.docker.internal`
  host alias during early integration work; set
  `CF_HARNESS_DOCKER_NETWORK_MODE=host` when a runtime should explicitly use
  host networking
- default sandbox image aligned with the public CFC kitchen-sink image published
  from the sibling `gvisor` repo:
  - `us-docker.pkg.dev/commontools-core/common-fabric/sandbox-kitchensink:latest`
  - override per run with `--sandbox-image` or `CF_HARNESS_SANDBOX_IMAGE`
- built-in tools:
  - `bash`
  - `bash-no-sandbox` (provisional host shell for named subagent profiles only)
  - `read_file`
  - `view_image`
  - `read_skill_resource`
  - `edit_file`
  - `write_file`
  - `delegate_task`
- targeted exact-string edits plus whole-file replace/create and append writes
- initial and in-run image attachments for model vision-capable flows
- bounded OpenAI-compatible prompt/tool loop
- single-child subagent delegation with fresh child prompt context, explicit
  default/browser child profiles, retained child run references, and a sanitized
  summary/state return channel
- optional schema-validated subagent structured returns, with raw child return
  artifacts retained in the child run and open-ended strings linkified before
  the parent sees them
- persisted run state, transcript, run reports, Loom run manifests, capability
  snapshots, and tool outputs, plus explicit skill registry and activation
  artifacts
- run-report gateway attempt diagnostics with chat-completion request size,
  timing, HTTP status, selected response headers/request IDs, and non-OK
  response body excerpts
- transcript-based resumability
- package-local operator CLI
- explicit Agent Skills preload via `--skills-root` and repeatable `--skill`
- runtime-generated supporting-resource indexes in `skill-registry.json`
- text-first supporting-resource reads through `read_skill_resource`, recorded
  in `skill-resource-reads.json`

The sandbox `bash` tool has a provisional direct-`curl` guard while sandbox
networking is enabled: explicit `curl` invocations may target loopback HTTP(S)
hosts such as `localhost`, `127.0.0.1`, and Docker Desktop's
`host.docker.internal` host alias, but obvious external `curl` targets are
denied before sandbox execution. This is an integration unblock, not a complete
network confinement model.

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
- dynamic/model-driven Agent Skills activation
- skill script execution
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
  - persisted run state, run manifest, transcript, run report, capability
    snapshot, and tool output storage
- [src/skills/](src/skills/)
  - Agent Skills registry scanning, validation, and explicit preload context
- [src/contracts/](src/contracts/)
  - prompt-slot, run-manifest, observation, policy, run-report, subagent, skill,
    transcript, and tool-result contracts
- [integration/](integration/)
  - environment-gated real `runsc-cfc` integration tests
- [docs/SKILLS_SUPPORT_SPEC.md](docs/SKILLS_SUPPORT_SPEC.md)
  - staged Agent Skills support design

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

Initial prompt image attachments:

```bash
cd packages/cf-harness
deno task run -- \
  --workspace /path/to/workspace \
  --gateway-auth-mode none \
  --image captures/example.png \
  --prompt "Describe the attached capture image and summarize useful next steps."
```

`--image` is repeatable and accepts `png`, `jpeg`, `gif`, and `webp` files
inside the workspace. Relative image paths are resolved from `--workspace`. The
transcript retains only image metadata (`hostPath`, media type, byte count,
digest); base64 pixels are materialized only for the gateway request.

Explicit skill preload:

```bash
deno task run -- \
  --workspace /path/to/common-fabric-2 \
  --cwd pattern-factory \
  --gateway-auth-mode none \
  --skills-root labs/skills \
  --skill pattern-dev \
  --skill pattern-implement \
  --prompt "Build this pattern."
```

Sandbox image override:

```bash
deno task run -- \
  --workspace /path/to/common-fabric-2 \
  --cwd pattern-factory \
  --gateway-auth-mode none \
  --sandbox-image registry.example/cf-harness-sandbox:deno2 \
  --prompt "Run deno task cf --help and report whether it works."
```

Use this for Deno 2 / Common Fabric CLI validation while keeping the mounted
workspace as the source of truth for Labs, Pattern Factory, and Loom code. Run
reports include the selected sandbox image in the capability snapshot.

Loom-backed batch runs may also pass a retained manifest:

```bash
deno task run -- \
  --workspace /path/to/workspace \
  --gateway-auth-mode none \
  --run-manifest /path/to/loom-run-manifest.json \
  --prompt "Handle this Loom wish."
```

Batch runs can require the agent to produce a schema-validated JSON sidecar
before the CLI exits successfully. `--result-json-path` remains the harness
metadata output; `--structured-result-path` is the agent-authored JSON file to
validate:

```bash
deno task run -- \
  --workspace /path/to/workspace \
  --gateway-auth-mode none \
  --output-mode batch \
  --result-json-path /tmp/cf-harness-result.json \
  --structured-result-path capture.results.json \
  --structured-result-schema-file /path/to/result.schema.json \
  --prompt "Write capture.results.json with the requested structured result."
```

The structured result path must stay inside the workspace. The schema may be
provided inline with `--structured-result-schema` or read from
`--structured-result-schema-file`. After the run, cf-harness reads the sidecar,
validates it with the same JSON Schema validation primitives used by subagent
`returnSchema`, records `structured_result` in the batch metadata, and exits
nonzero when the file is missing, invalid JSON, or schema-invalid.

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
subagent result. Browser/page output is treated as untrusted child-local data;
with a `returnSchema`, parent-visible free-form strings are replaced by opaque
links while raw observations stay in child artifacts. The browser child can read
workspace files but does not receive `edit_file` or `write_file`, so it should
return findings through the structured return channel rather than by writing
browser observations into the workspace. The host shell is policy-restricted to
`agent-browser` attached through an approved local CDP endpoint, `agent-browser`
discovery (`which agent-browser`, `command -v agent-browser`), `pwd`, `ls`, and
bounded workspace-local `find` commands. Page commands should use the Loom
Browser Access endpoint supplied by the task, for example
`agent-browser --cdp http://host.docker.internal:9362 snapshot -i`. Bare
`agent-browser open` / `snapshot` launches are denied so the child cannot race
the host's live browser profile. `agent-browser eval` is not available in this
profile; browser subagents should inspect pages with commands such as
`snapshot`, `get`, `find`, locator actions, and normal browser interactions.

For browser-profile runs, prefer a host artifact root outside the workspace. Raw
child artifacts are retained for operator analysis, but they are not meant to
become ordinary workspace inputs for the parent model. If an artifact root is
physically placed under the workspace, `read_file`, `view_image`, `write_file`,
and `edit_file`, plus browser-profile `ls`/`find`, treat that artifact tree as
reserved from model-facing file and discovery tools.

```bash
ROOT=/tmp/cf-harness-browser-demo
mkdir -p "$ROOT/workspace" "$ROOT/artifacts"

deno task run -- \
  --workspace "$ROOT/workspace" \
  --artifact-root "$ROOT/artifacts" \
  --gateway-auth-mode none \
  --allow-tool delegate_task \
  --allow-subagent-profile browser \
  --prompt "Delegate browser inspection of the local app and summarize the result."
```

Programmatic `delegate_task` calls may include `returnSchema`, a JSON Schema
object or boolean. In that mode the child is required to return a single JSON
value. The harness validates it, stores the raw child return under the child
artifact root, and exposes `subagent.structuredReturn.value` to the parent with
free-form strings and objects with unmodeled keys replaced by opaque `@link`
objects such as `opaque:<child-run-id>#/json/pointer`:

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
- skills support is explicit preload only for now:
  - `--skill` requires `--skills-root`
  - skill preload is not supported with `--resume-run`
  - dynamic `load_skill` activation is still planned

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

To opt into a local Labs CLI smoke inside the sandbox, use a Deno 2-compatible
image and enable the CF CLI case:

```bash
cd packages/cf-harness
CF_HARNESS_INTEGRATION_IMAGE=registry.example/cf-harness-sandbox:deno2 \
CF_HARNESS_INTEGRATION_CF_CLI=1 \
deno task test:integration
```

That case mounts the current Labs checkout as `/workspace` and runs
`deno task cf --help` inside the `runsc-cfc` sandbox. It is skipped by default
because the published kitchen-sink image may not have the required Deno version
or cache state.

To also exercise a real host Fabric FUSE mount bind-mounted into the sandbox at
`/fabric`, start `cf fuse mount` separately and pass the mountpoint:

```bash
cd packages/cf-harness
CF_HARNESS_INTEGRATION_FABRIC_MOUNT=/tmp/cf deno task test:integration
```

That opt-in case verifies that cf-harness can navigate `/fabric` through
`runsc-cfc` and read the FUSE `.status` file. Without
`CF_HARNESS_INTEGRATION_FABRIC_MOUNT`, the Fabric mount case is skipped.

To exercise label flow through a live Fabric FUSE projection, enable the
additional CFC flow tests and provide concrete read/write projection paths under
`/fabric`:

```bash
# In another terminal, mount FUSE with Docker traversal enabled.
cf fuse mount /tmp/cf --allow-other --cfc-mode=observe --cfc-writeback-xattrs

cd packages/cf-harness
CF_HARNESS_RUNSC_CFC_RESULT_DIR="$HOME/.local/share/runsc-cfc/cfc-results" \
CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR="$HOME/.local/share/runsc-cfc/cfc-invocations" \
CF_HARNESS_INTEGRATION_FABRIC_MOUNT=/tmp/cf \
CF_HARNESS_INTEGRATION_FABRIC_CFC_FLOW=1 \
CF_HARNESS_INTEGRATION_FABRIC_CFC_READ_PATH=/fabric/home/pieces/example/result/secret \
CF_HARNESS_INTEGRATION_FABRIC_CFC_WRITE_PATH=/fabric/home/pieces/example/result/output \
CF_HARNESS_INTEGRATION_FABRIC_CFC_LABEL_SUBJECT=did:key:fabric \
deno task test:integration
```

When those env vars point at a real labeled FUSE fixture, the extra tests probe
FUSE-to-sandbox taint, command completion after a FUSE read, FUSE write
attempts, and joins between explicit `cfcInputLabels` and a prior FUSE read. The
result sidecar env var is required for all CFC flow assertions, and the
invocation context sidecar env var is required for the cases that seed
`cfcInputLabels`. The installed Docker `runsc-cfc` runtime must also be
configured with the same `--cfc-invocation-context-dir`, otherwise those
invocation-label cases are skipped even if cf-harness writes sidecars.

The default Fabric CFC flow gate exercises the immediate result sidecar after a
FUSE read. The stricter host-bind readback probe is opt-in with
`CF_HARNESS_INTEGRATION_FABRIC_CFC_DURABLE_HOST_LABEL=1` because durable
`FUSE -> sandbox -> host -> sandbox` label persistence is still a live-stack
validation target. FUSE write assertions are also probes of the live stack:
durable cell-label writeback depends on the runner/runtime emitting FUSE
prepare/finalize metadata, not arbitrary direct writes to
`trusted.cfc.contentLabel`.

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
payload contains audit/provenance context plus optional trusted `cfcInputLabels`
for supported startup inputs (`command`, `argv`, `args`, `env`, `cwd`, and
`stdin`). `stdin` labels are modeled as labels on the stdin source and taint
only after the sandbox reads or maps fd 0, not as automatic startup task taint.

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
