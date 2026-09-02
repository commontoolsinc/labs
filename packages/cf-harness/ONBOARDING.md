# cf-harness onboarding: one task to an openable piece

Every command below is literal. Run it from the directory named above the block;
replace only values in `<angle-brackets>`.

## 1. What this is

- `cf-harness` gives an agent a bounded prompt-and-tool loop.
- Input cells enter that loop as handles, not copied values.
- Patterns run beside those cells in one configured Fabric space.
- Successful work is durable as a piece, and a slug makes it openable.
- CFC policy and artifacts make the run inspectable after it ends.

**Goal:** weaver pill → harness session → openable, reactive, CFC-governed
piece.

The two ideas underneath the flow are
[handles and patterns](README.md#the-model-handles-and-patterns): a schema
decides what may cross as a value, and computation goes to the referenced data.
The web service implements clauses 1–4 of the
[weaver service contract](https://linear.app/common-tools/issue/CT-2155);
local-auth simplification is still open under clause 5.

### The three demos

- [CT-2190](https://linear.app/common-tools/issue/CT-2190/demo-the-weaver-pill-cf-harness-session-openable-cfc-governed-piece)
  demonstrates the Weaver pill → harness → openable, CFC-governed piece; this
  document is its runbook.
- [CT-2189](https://linear.app/common-tools/issue/CT-2189/demo-bills-dashboard-from-gmail-plaid-connectors-cfc-governed-alexs)
  demonstrates the connector-fed bills dashboard over Gmail and Plaid; its
  loom-side gaps are stated on the issue.
- [CT-2091](https://linear.app/common-tools/issue/CT-2091/ct-2066-demo-the-hostile-skill-run-and-the-act-2-taint-renderer)
  demonstrates the skills.sh hostile-skill flow and its CFC-governed
  prompt-injection refusal.

## 2. Prerequisites

1. Use the Deno version pinned by `mise.toml`:

   ```sh
   cd <labs>
   mise install
   export PATH="$HOME/.local/share/mise/installs/deno/2.9.4/bin:$PATH"
   deno --version
   ```

   Success is `deno 2.9.4`.

2. Start Docker and register the `runsc-cfc` runtime. On macOS, follow the
   gVisor
   [Docker Desktop CFC setup guide](https://github.com/commontoolsinc/gvisor/blob/cfc_v2/g3doc/user_guide/quick_start/docker_desktop_cfc.md);
   it owns the installation and registration procedure. Confirm only the
   resulting contract here:

   ```sh
   docker info --format '{{json .Runtimes}}'
   ```

   Success is a `runsc-cfc` entry whose `runtimeArgs` name both
   `--cfc-result-dir` and `--cfc-invocation-context-dir`.

3. Obtain a PKCS#8 identity keyfile. This one identity signs both the Fabric
   session and pattern-index requests. To mint one:

   ```sh
   cd <labs>
   deno run -A packages/cli/mod.ts id new > "$HOME/.cf-demo.key"
   chmod 600 "$HOME/.cf-demo.key"
   deno run -A packages/cli/mod.ts id did "$HOME/.cf-demo.key"
   ```

   Success is a printed `did:key:z6Mk…`. Set `CF_IDENTITY` to an existing
   keyfile instead when one already owns the target space.

4. Connect the `openai-codex` provider:

   ```sh
   cd <labs>/packages/cf-harness
   deno task run -- auth login openai-codex
   deno task run -- auth status openai-codex
   deno task run -- config set openai-codex
   ```

   Success is `auth status` reporting the credential as connected. These files
   live under `CF_HARNESS_HOME`, which defaults to `$HOME/.cf-harness`.

5. Put the identity's DID on the pattern-index allowlist. Follow
   [pattern-index ONBOARDING §2](https://github.com/commontoolsinc/pattern-index/blob/main/ONBOARDING.md#2-access),
   including its signed search check. Success is HTTP `200` with a `results`
   array; `403` means the signer is not allowlisted.

For commands below, either use an installed `cf` or define this source-checkout
equivalent once:

```sh
export LABS_ROOT=<labs>
cf() { (cd "$LABS_ROOT" && deno task cf "$@"); }
```

## 3. Start the environment

The working demonstration uses toolshed on `:8063`, shell on `:5173`, and the
console on `:8135`. Use three terminals. The general server lifecycle and log
locations remain in
[Local Development Servers](../../docs/development/LOCAL_DEV_SERVERS.md); the
commands here spell out each process so the serving store is explicit.

### Terminal 1: toolshed

`MEMORY_DIR` must be a `file://` URL when toolshed serves an existing directory
store. The full configuration contract is in
[Configuration — Memory store](../../docs/development/CONFIGURATION.md#memory-store).

```sh
cd <labs>/packages/toolshed
export PATH="$HOME/.local/share/mise/installs/deno/2.9.4/bin:$PATH"
export MEMORY_DIR=file:///absolute/path/to/serving-labs/packages/toolshed/cache/memory/
export SHELL_URL=http://127.0.0.1:5173
export API_URL=http://127.0.0.1:8063
export MEMORY_URL=http://127.0.0.1:8063
deno run --unstable-otel -A --env-file=.env index.ts --port=8063
```

Success is `Server is starting on port http://0.0.0.0:8063`, followed by an HTTP
response from:

```sh
curl -sS http://127.0.0.1:8063/api/meta | jq '{gitSha, cfc}'
```

### Terminal 2: shell

Use `dev-local`; `dev` points at the cloud backend.

```sh
cd <labs>/packages/shell
export PATH="$HOME/.local/share/mise/installs/deno/2.9.4/bin:$PATH"
TOOLSHED_PORT=8063 deno task dev-local
```

Success is the felt development server listening on `http://127.0.0.1:5173`.

### Terminal 3: console

These are all of the environment values needed for the full harness path. The
console's `MEMORY_DIR` is deliberately a plain directory path: it is the
reader's hint for finding the same space database toolshed serves, not
toolshed's URL-valued configuration.

```sh
cd <labs>/packages/cf-harness
export PATH="$HOME/.local/share/mise/installs/deno/2.9.4/bin:$PATH"
export CF_HARNESS_CONSOLE_PORT=8135
export CF_HARNESS_CONSOLE_DIR="$PWD/.cf-harness-console-weaver-demo"
export CF_HARNESS_FABRIC_API_URL=http://127.0.0.1:8063
export CF_HARNESS_FABRIC_IDENTITY=<absolute-path-to-identity-keyfile>
export CF_HARNESS_FABRIC_SPACE=weaver-demo
export CF_HARNESS_PATTERN_INDEX_URL=https://us-central1-pattern-index.cloudfunctions.net
export CF_HARNESS_SKILLS_REGISTRY_URL=https://skills.sh
export CF_HARNESS_FABRIC_CFC_POSTURE=max-enforcement
export CF_HARNESS_FABRIC_CFC_FLOW_LABELS=persist
export CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE=enforce-explicit
export CF_HARNESS_RUNSC_CFC_RESULT_DIR="$HOME/.local/share/runsc-cfc/sidecars/results"
export CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR="$HOME/.local/share/runsc-cfc/sidecars/invocation-context"
export MEMORY_DIR=/absolute/path/to/serving-labs/packages/toolshed/cache/memory
deno task console
```

Success is a startup summary naming `weaver-demo`, the toolshed and index URLs,
and `max-enforcement, flow labels persist, enforce-explicit`, followed by an
HTTP `200` here:

```sh
curl -sS http://127.0.0.1:8135/api/health | jq
```

The expected health body is:

```json
{
  "ok": true,
  "fabricApiUrl": "http://127.0.0.1:8063",
  "fabricSession": "unverified"
}
```

Before spending a provider turn, make the parity check:

```sh
test "$(curl -sS http://127.0.0.1:8063/api/meta | jq -r .gitSha)" = \
  "$(git rev-parse HEAD)"
```

No output and exit status `0` is success. The toolshed `/api/meta.gitSha` must
equal the checkout from which the console is running; restart the servers when
it does not.

## 4. Seed a labeled input cell by hand

Save this pattern as `finance-data.tsx` in the labs root. It passes the
`account` input through to the `account` result and renders its balance:

```tsx
import { type Default, NAME, pattern, UI } from "commonfabric";

interface Transaction {
  date: Default<string, "">;
  description: Default<string, "">;
  category: Default<string, "">;
  amount: Default<number, 0>;
}

interface FinanceData {
  account: {
    balance: Default<number, 0>;
    transactions: Default<Transaction[], []>;
  };
}

export default pattern<FinanceData, FinanceData>(({ account }) => ({
  [NAME]: "Transaction data",
  [UI]: <div>Balance: {account.balance}</div>,
  account,
}));
```

From the labs root, deploy the file, keep the printed piece ID, and attach the
confidentiality label through the checked piece-data write path:

```sh
cd <labs>
export CF_API_URL=http://127.0.0.1:8063
export CF_IDENTITY=<absolute-path-to-identity-keyfile>
export CF_SPACE=weaver-demo

cf piece new --slug transaction-data finance-data.tsx
export INPUT_PIECE_ID=<the-printed-fid1-id>
echo '{"balance":2417.55,"transactions":[{"date":"2026-09-01","description":"Donuts","category":"Food","amount":24.50}]}' | \
  cf set --cell "$INPUT_PIECE_ID" --input account
cf piece step --cell "$INPUT_PIECE_ID"
echo '{"confidentiality":["finance"]}' | \
  cf piece set-label --cell "$INPUT_PIECE_ID" account
cf piece get-label --cell "$INPUT_PIECE_ID" account
```

`cf piece new` succeeds by printing a `fid1:…` piece ID and the
`transaction-data` slug. `cf set` writes the sample account into the piece's
input, and `cf piece step` makes the pass-through result current. The final
readback succeeds with this shape:

```json
{
  "version": 1,
  "entries": [{ "path": [], "label": { "confidentiality": ["finance"] } }]
}
```

The demo input reference is the entity form of that result path:

```sh
export INPUT_CELL_REF="/of:${INPUT_PIECE_ID}/account"
```

The `/of:` prefix is required. The `/fid1:…` form printed in some piece hints is
not an input-cell entity URI.

## 5. Drive a run over the web API

The route and event contracts are authoritative in
[the console README](console/README.md#http-routes). Every `/api` route except
health needs the per-process cookie set by `GET /`; loopback alone is not
authorization.

### Get the cookie and submit

```sh
export CONSOLE_URL=http://127.0.0.1:8135
export COOKIE_JAR=$(mktemp /tmp/cf-harness-cookie.XXXXXX)
curl -sS -c "$COOKIE_JAR" "$CONSOLE_URL/" >/dev/null

TASK_RESPONSE=$(curl -sS -b "$COOKIE_JAR" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg ref "$INPUT_CELL_REF" '{
    text: "Make me a budget dashboard from my transaction data — totals by category that update when the data changes.",
    inputCells: [{name: "transactions", ref: $ref}]
  }')" \
  "$CONSOLE_URL/api/task")
printf '%s\n' "$TASK_RESPONSE" | jq
export SESSION_ID=$(printf '%s' "$TASK_RESPONSE" | jq -r .sessionId)
export TURN_ID=$(printf '%s' "$TASK_RESPONSE" | jq -r .turnId)
```

Success is HTTP `200` with non-empty `sessionId` and `turnId`. To continue an
existing harness conversation, add `sessionId` to the submitted object. Each
`inputCells` entry is `{name, ref}`; `ref` must be an entity link such as
`/of:fid1:…/path` (or `computed:`), and an invalid spelling is HTTP `400` before
a turn starts.

### Wait for completion

Prefer the event-driven SSE stream:

```sh
curl -N -b "$COOKIE_JAR" \
  "$CONSOLE_URL/api/events?sessionId=$SESSION_ID"
```

Success is a terminal `turn_completed` event whose `result` has the structured
shape below. `turn_failed` and `turn_canceled` are terminal failures.

A caller that cannot hold SSE can ask once and repeat only while it receives
`409`:

```sh
curl -i -sS -b "$COOKIE_JAR" \
  "$CONSOLE_URL/api/turns/$TURN_ID/result"
```

The whole polling rule is `409` keep asking, `200` read the result, `410` stop
with the terminal failure. A `404` is either an unknown turn or a completed turn
whose artifacts are unavailable; inspect its `code`.

Once the status is `200`, retain the body for the remaining commands:

```sh
TURN_RESULT=$(curl -sS -b "$COOKIE_JAR" \
  "$CONSOLE_URL/api/turns/$TURN_ID/result")
printf '%s\n' "$TURN_RESULT" | jq
```

The successful structured result is:

```json
{
  "pieces": [
    {
      "slug": "budget-dashboard",
      "url": "http://127.0.0.1:8063/weaver-demo/budget-dashboard"
    }
  ],
  "spaceName": "weaver-demo",
  "finalText": "Your budget dashboard is ready."
}
```

`pieces` is always present and may be empty. A caller opens `pieces[0].url`; it
does not parse `finalText` to find a link.

### Resolve, render, and open the piece

```sh
export SLUG=$(printf '%s' "$TURN_RESULT" | jq -r '.pieces[0].slug')
cf get "/$SLUG"
export PIECE_ID=$(cf get "/$SLUG" --select '@' | \
  jq -r '."$link" | sub("^/of:"; "")')
cf piece render --cell "$PIECE_ID"
```

The first `cf get /<slug>` succeeds by returning the piece's live result. The
`--select '@'` form returns `{"$link":"/of:fid1:…"}`; stripping `/of:` gives the
ID that `cf piece render` accepts. Success there is rendered HTML. Render by ID
because render-by-slug currently crashes (CT-2185).

The direct shell address is:

```text
http://127.0.0.1:5173/<space-name>/<slug-or-fid1-id>
```

The URL returned by the console uses the toolshed origin (`:8063` here), which
proxies the same shell and is also openable.

## 6. Read the evidence and run the CFC audit

A console run lives at:

```text
<CF_HARNESS_CONSOLE_DIR>/runs/<runId>/
├── run-state.json
├── transcript.json
├── run-report.json
├── policy-snapshot.json
├── policy-trace.json
├── tool-outputs/
└── cell-labels.json       # read from the space as the run ended
```

The console's Runs view renders the same tree. A caller may rely on
`run-state.json` for `runId`; lifecycle `status`; `createdAt`, `updatedAt`, and
terminal `endedAt`/`terminalReason`; the selected model and provider; the
harness and `fabricSessionCfc` postures; `inputCells`; artifact paths;
`toolOutputs`; child lineage; and `failureRecords`/`primaryFailure`. A run stays
`running` until one terminal write changes it to `completed` or `failed`.

The terminal write that records the `run-state.json` outcome also writes
`cell-labels.json`, from a read of the space as the run ended. The parent and
every `delegate_task` child perform and record their own read. When `--space-db`
selects the store, each child inherits it from the parent. A snapshot that
cannot be taken or written produces a failure record on that run with
`source: "cell_labels"`.

Use the other records for their narrower evidence:

- `transcript.json` is the durable provider-safe conversation and tool-call
  sequence.
- `tool-outputs/` holds every full tool result, including the `assign_slug`
  result from which the console constructs `pieces[{slug,url}]`.
- `policy-trace.json` holds CFC policy decisions; `policy-snapshot.json` holds
  the run-level harness posture.
- `cell-labels.json`, when present and `status` is `read`, is the terminal
  snapshot read from the space. `unavailable` and `no-document` are not evidence
  that a cell is unlabeled.

Read the store live as an independent check:

```sh
cf piece get-label --cell "$INPUT_PIECE_ID" account
cf piece get-label --cell "$PIECE_ID" <derived-result-path>
```

Then audit the root run and its `delegate_task` children:

```sh
cd <labs>/packages/cf-harness
deno task cfc-audit "$CF_HARNESS_CONSOLE_DIR/runs/$TURN_ID"
```

Or audit the whole artifact root:

```sh
deno task cfc-audit "$CF_HARNESS_CONSOLE_DIR/runs" --fail-on inconclusive
```

The [CFC audit reference](README.md#the-cfc-audit) defines AUD-1 through AUD-9
and their cited clauses. Read verdicts literally: `pass` is established;
`not-applicable` means complete evidence showed the subject did not arise;
`warn` means weaker assurance; `fail` is a contradicted requirement; and
`inconclusive` means required evidence was absent or unreadable. `inconclusive`
is never `pass`. AUD-9's detail says whether the terminal cell-label read was
attempted. A path containing no run exits `2` because nothing was audited.

## 7. Run the CLI path instead

The batch CLI and console resolve the same session configuration. The CLI
refuses an enforcing run unless both runsc-cfc transports are named:

```sh
cd <labs>/packages/cf-harness
export PATH="$HOME/.local/share/mise/installs/deno/2.9.4/bin:$PATH"
export CF_HARNESS_RUNSC_CFC_RESULT_DIR="$HOME/.local/share/runsc-cfc/sidecars/results"
export CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR="$HOME/.local/share/runsc-cfc/sidecars/invocation-context"

deno task run -- \
  --output-mode batch \
  --artifact-root .cf-harness-cli/runs \
  --workspace .cf-harness-cli/workspace \
  --fabric-api-url http://127.0.0.1:8063 \
  --fabric-identity <absolute-path-to-identity-keyfile> \
  --fabric-space weaver-demo \
  --fabric-cfc-posture max-enforcement \
  --space-db /absolute/path/to/serving-labs/packages/toolshed/cache/memory/engine-v3/engine-v3/<space-did>.sqlite \
  --input-cell "transactions=/of:${INPUT_PIECE_ID}/account" \
  --prompt "Make me a budget dashboard from my transaction data — totals by category that update when the data changes."
```

Success is exit status `0` and a completed operator summary naming the run
artifact directory. A result handle or slug appears in the final response and
retained tool output when the run produced one. `--space-db` is the exact space
database used only by the terminal label reader; it does not change the Fabric
session's target, and every `delegate_task` child inherits it.
[Running patterns against a Fabric space](README.md#running-patterns-against-a-fabric-space)
defines the three required session flags and the input-cell behavior.

## 8. Experiments and measurement

[Measuring the pattern index loop](docs/pattern-index-measurement.md) is the
protocol for comparable experiments: the fixed task suite, the rule that a
discovery task must not mention the index, the CFC and server-parity readings,
and how label persistence is attributed to the writing session. With a console
running, the executable entry is
`deno task measure-batch
scripts/pattern-index-suite.json --console=http://127.0.0.1:8135
--fabric-api-url=http://127.0.0.1:8063
--out=.cf-harness-console-weaver-demo/measurements/<name>`
from `packages/cf-harness`; success writes `report.md` and `report.json` and
exits zero only when every task completed. The pattern-index repository's
[own onboarding](https://github.com/commontoolsinc/pattern-index/blob/main/ONBOARDING.md)
owns allowlisting, signed direct calls, corpus behavior, and its repo map.

## 9. What works today and what does not

[Current state](docs/CURRENT_STATE.md) is the maintained capability inventory.
For this path, the batch and interactive loops, input-cell handles, host-side
`run_pattern`, slug assignment, structured web completion, durable artifacts,
pattern-index search/publication, CFC posture records, provider-attempt records,
and the offline audit are usable now.

The boundaries that affect this onboarding are:

- CT-2175: a `run_pattern` call without `resultSchema` receives the result
  handle without consulting the ceiling. If the ceiling refuses requested
  values, the call still receives the handle, with `value` withheld, a
  `valueError` that explains why and names the input carrying the label, and
  `policyRefusal` as structured data. Declassification by policy — releasing a
  value under one policy and refusing it under another — remains open.
- CT-2155 clause 5: protected web routes still use the `GET /` cookie exchange;
  there is no shared bearer-token shortcut.
- CT-2185: `cf piece render --cell /<slug>` crashes; resolve with `cf get` and
  render by `fid1:` ID.

## 10. Troubleshooting

**Healthy console, dead Fabric.** `/api/health` returning HTTP `200` with
`fabricSession: "unverified"` is honest by design: it does not make a Fabric
round trip. Probe toolshed `/api/meta`, run the parity check, and perform a real
`cf get` before spending a model turn.

**Wrong store.** `cell-labels.json` with `unavailableReason:
"space-not-found"`,
or every cell carrying `unreadReason: "no-document"`, usually means the label
reader opened no store or another worktree's store. Give the console the serving
toolshed's plain `MEMORY_DIR`; give a CLI run the exact `--space-db`.
[Reading the labels back](docs/pattern-index-measurement.md#reading-the-labels-back)
defines both forms.

**Provider overload.** Inspect `run-report.json.modelAttempts`. A failed attempt
preserves the provider's `providerError.type`, `code`, and `message`; errors
such as `server_is_overloaded` are provider capacity signals, not a Fabric or
Docker diagnosis.
[Model attempts and transport retry](README.md#model-attempts-and-transport-retry)
defines the bounded retry contract.

**Sandbox refusal under `enforce-explicit`.** Check the startup banner,
`policy-trace.json`, full `tool-outputs/`, and Docker's registered runtime args.
The harness-side directories must match the host side of runsc-cfc's
`--cfc-result-dir` and `--cfc-invocation-context-dir`; on Docker Desktop the
runtime sees their `/host_mnt/...` projections. A refusal is evidence to read,
not a reason to silently drop to `observe`.

**Concurrent consoles.** Never point two console processes at one
`CF_HARNESS_CONSOLE_DIR`. Until CT-2156 closes, shared session and artifact
directories can interleave records. Give each process an absolute, unique
directory.

## 11. Repo map

- [`README.md`](README.md) — complete harness model, CLI surface, runtime tools,
  provider behavior, and CFC audit reference.
- [`console/README.md`](console/README.md) — console configuration, web API,
  SSE, structured result, label snapshot, and operator views.
- [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md) — maintained capability and
  limitation inventory.
- [`docs/pattern-index-measurement.md`](docs/pattern-index-measurement.md) —
  comparable experiment protocol and store-reading rules.
- [`src/session-assembly.ts`](src/session-assembly.ts) — the one session
  assembly shared by console and batch CLI.
- [`src/run-state.ts`](src/run-state.ts) — durable `run-state.json` contract.
- [`audit/checks/structural.ts`](audit/checks/structural.ts) — AUD-1 through
  AUD-9 implementations.
- [`../../docs/development/LOCAL_DEV_SERVERS.md`](../../docs/development/LOCAL_DEV_SERVERS.md)
  — toolshed/shell lifecycle and `dev-local` rule.
- [`../../docs/development/CONFIGURATION.md`](../../docs/development/CONFIGURATION.md)
  — environment-variable authority, including toolshed's URL-valued
  `MEMORY_DIR`.
- [pattern-index `ONBOARDING.md`](https://github.com/commontoolsinc/pattern-index/blob/main/ONBOARDING.md)
  — allowlist, signed API calls, corpus behavior, troubleshooting, and the
  pattern-index repo map.
