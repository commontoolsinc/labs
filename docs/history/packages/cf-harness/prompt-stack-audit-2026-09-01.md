---
status: historical
created: 2026-09-01
archived: 2026-09-01
reason: "Point-in-time audit of every cf-harness model-context surface and its factual claims."
---

# cf-harness prompt-stack audit, 2026-09-01

## Verdict

The prompt stack is load-bearing and currently has no single owner or truthful
center. The console parent defaults to no system prompt, while the CLI parent
always receives a substantial preamble. The experimental V2 console prompt
made both Terra and Sol compose, but its crucial search-to-child handoff is an
untyped prose convention, its blanket instruction to import search hits causes
whole applications to be wrapped as components, and four of its system claims
have drifted.

Two tool descriptions have live, behavior-changing drift:

- `search_patterns` still teaches a query strategy for the old matcher and
  discards the endpoint's new `kind` and `quality` fields. It also promises
  argument and result shapes for every hit while fetching them for only five
  of ten.
- `run_pattern` states the disproved CT-2123 keyless-result hypothesis as a
  law in three model-facing places. The harness detects the actual keyless
  pointer, but its retry message guesses the cause.

The highest-effect redesign is therefore not “add more composition prose.” It
is: give the console parent a small default decision policy, expose `kind` on
search hits, and carry selected hits across delegation as structured context.
The child should retain search, publishing, compile-loop, reference, and return
contract guidance. The four child composition bullets remain an unmeasured
variable; run V1 before keeping or deleting them.

This audit is read-only. All verdicts are against `commontoolsinc/labs`
`origin/main` at `e6f3b777680ffc269bf7294d968c8698f2a8c7bc` and the deployed matcher source in
`commontoolsinc/pattern-index` `main` at
`c48e61dc90e85289104f49586115ea66f442ecf0`.

Unless a path starts with `packages/` or `docs/`, paths beginning `src/`,
`scripts/`, `tools/`, or `contracts/` below are relative to
`packages/cf-harness/`. A `pattern-index@c48e61d` prefix identifies the separate
pattern-index repository and its pinned commit.

## Method and inventory boundary

A “prompt surface” here means every fixed string, schema description, dynamic
payload family, or prior-context transformation that can enter a model request.
Dynamic values such as a user's task, file contents, compiler diagnostics, web
pages, and child summaries cannot be enumerated value by value; their producer
and wrapper are the auditable surface. Terminal errors that never receive a
following model turn are recorded as non-surfaces so they are not mistaken for
retry prompts.

The complete surface census is:

1. Console parent system prompt file, including the no-prompt default and the
   committed V2 experiment prompt.
2. CLI parent base, operator, batch, mount, structured-result, additional
   instruction, and skill-guidance prompts.
3. User task text, context messages, image attachments, durable transcript
   replay, and provider continuation/compaction items.
4. Common subagent system prompt and the default, browser, web-fetch,
   web-search, and pattern-author profile additions.
5. Delegation `goal`, `context`, return schema, handle seeding, and the
   `Task:`/`Context:` child wrapper.
6. Registry and handle-delivered skill-context injection, resource indexes,
   and skill-script guidance.
7. All 15 registered tool names, descriptions, input/output schemas, and native
   provider search declarations.
8. All tool outputs after CFC mediation, handle swapping, identifier scrubbing,
   and truncation.
9. Invalid-tool-call, authorization, observation-denied, and schema retry
   messages.
10. File, browser, web, skill, handle, slug, search, and feedback errors.
11. `run_pattern` validation, lookup, composition, compile, startup, keyless,
    CFC-refusal, settle, and convergence messages.
12. Pattern publication and render-gate reasons.
13. Child structured returns, sanitized summaries, failures, and retained run
    metadata returned to the parent.
14. Provider-native search declarations and opaque provider reasoning and
    encrypted compaction continuation items.

The deep audit follows the requested priority: delegation, pattern search and
run, pattern-author, console parent, and retry/refusal text. The remaining
surfaces were surveyed to the fixed-literal and control-flow depth stated in
their entries.

## 1. Parent prompt assembly

### 1.1 Console default and prompt file

- **Surface and recipient:**
  `packages/cf-harness/console/server.ts:323-360,389-418,1334-1361` and
  `packages/cf-harness/src/interactive-chat-service.ts:73-85,1417-1435`;
  console parent.
- **When it fires:** a non-empty file named by `--system-prompt-file` or
  `CF_HARNESS_CONSOLE_SYSTEM_PROMPT_FILE` is seeded once, on the first turn of
  each durable session. With neither setting, there is no system message.
- **Claims and truth:** “default is no system message” is **true**: the service
  option is omitted at `console/server.ts:1359-1361`, and the transcript seed is
  conditional at `interactive-chat-service.ts:1420-1424`. “The parent's only
  standing guidance is tool descriptors” is **substantially true**, with the
  qualification that provider policy and any durable transcript history also
  enter later turns (`interactive-chat-service.ts:1425-1435`). Empty or
  unreadable named files fail startup, as claimed, at
  `console/server.ts:345-360`.
- **Disposition:** **fix** by making a successor to V2 the console default;
  leaving the orchestration parent with only tool-local descriptions reproduces
  the measured V0 failure to search and compose.

### 1.2 Committed V2 parent prompt

- **Surface and recipient:**
  `packages/cf-harness/.cf-harness-console/measurements/2026-08-31-terra-vs-sol-2x2/parent-composition-prompt.txt:1-13`;
  console parent, only when explicitly loaded for the experiment.
- **When it fires:** the V2 cells used `--system-prompt-file` and
  `--no-child-composition-guidance`; it is not a product default.
- **Claims and truth:** each claim is separated below.

| Line | Claim | Current-main verdict and evidence | Disposition |
| --- | --- | --- | --- |
| 1 | The console parent builds by delegating to a `pattern-author`, which runs source and returns a result-cell reference. | **True.** The profile owns `run_pattern`, has no file-write tools, and its return schema requires `resultRef` (`src/contracts/subagent.ts:67-87,239-267`). | **Keep**, shortened. |
| 3 | Search returns each hit's description, argument/result shapes, and import specifier, never source. | **Drifted.** Source is withheld and every hit gets an import hint, but only the first five of ten get detail fetches and shapes (`src/tools/search-patterns.ts:27-35,217-251`). | **Fix** to “leading hits may include shapes”; expose missing endpoint metadata. |
| 5 | Search before every delegation. | **Directionally useful, over-broad.** Search is available only with an index (`src/contracts/subagent.ts:73-87`), and browser/web/default tasks may not be pattern work. | **Fix** to apply before pattern-author delegation. |
| 7 | Decompose requests and search verbs/parts, not only the whole. | **Useful guidance, not a system fact.** The current matcher searches stopword-free whole words over descriptions, keywords, and tags (`pattern-index@c48e61d functions/src/handlers/search-patterns.ts:125-136,232-264`). | **Keep**, but say “content words and capability verbs,” not “rather than nouns.” |
| 9 | A result answering a part should be delegated with its ID for import; a child handed an ID composes it, while one handed only a whole-app description writes from scratch and fails more. | **Mixed and contradicted.** An ID can be run directly, and the child is explicitly told to do so when the hit already does the job (`src/prompt-loop.ts:1186`). In the V2 counter transcript the child ran the whole hit by ID. Whole-application compile failure is not a law. | **Fix** into a decision: run whole hits by ID; compose reusable parts only. |
| 11 | Rewriting creates a duplicate with no basis for preference. | **Overstated.** Duplicate capabilities can still be published, but per-session publication supersedes same-description/tag iterations (`src/tools/run-pattern.ts:1609-1629`; `src/pattern-index/publish-render-gate.ts:214-215`), and ranking has evidence signals. | **Keep the anti-rewrite goal**, delete the absolute causal claim. |
| 13 | Naming findability words lets a later search find what this run publishes. | **Drifted.** Default publication is recorded-only and explicitly not offered to search (`src/tools/run-pattern.ts:1657-1707`; `src/pattern-index/publish-render-gate.ts:202-203`). | **Fix** to say metadata is recorded for evaluation and possible later promotion. |

The V2 prompt should become the basis of a default, not become the default
verbatim. Its missing edge should read:

> Do not wrap a search hit merely to demonstrate composition. If one hit
> already answers the whole request—especially a complete application with its
> own UI or a static mockup—run it directly by `patternId` and name that piece.
> Compose only when the request needs behavior the whole hit lacks, or when a
> selected hit is a reusable part whose argument and result shapes you can wire.
> Use the hit's `kind`, description, and shapes to decide; an application is not
> made more reusable by putting a one-line wrapper around it.

### 1.3 CLI parent preamble

- **Surface and recipient:** `packages/cf-harness/src/cli.ts:2022-2173`; CLI
  parent.
- **When it fires:** every new CLI run. Operator mode adds focused exploration;
  batch mode omits it. Mount, structured-result, `--system-prompt`, and skill
  paragraphs are conditional.
- **Claims and truth:** the Common Fabric/pattern summary and controlled-tool,
  provenance, CFC, and workspace claims are **true** against prompt-loop tool
  registration and policy assembly (`src/prompt-loop.ts:2445-2483,2665-2687`).
  The delegation contract, failure branch, and `describe_handle` claims are
  **true** (`src/contracts/subagent.ts:150-267` and
  `src/tools/describe-handle.ts:84-113,117-187`). Structured-result path and
  validation claims are **true** (`src/cli.ts:2045-2058`). Mount lines are
  generated from the resolved mount configuration (`src/cli.ts:2061-2081`).
  Skill precedence, resource loading, and metadata fallback are **true**
  (`src/skills/registry.ts:854-905` and
  `src/tools/read-skill-resource.ts:317-449`). `--system-prompt` is appended as
  “Additional instructions,” not substituted (`src/cli.ts:2036-2043`). No live
  drift was found at fixed-literal/control-flow depth.
- **Disposition:** **keep**. Do not reuse the whole CLI prompt as the console
  default: it is an autonomous workspace-agent prompt, while the console parent
  is a pattern-building orchestrator.

## 2. User, history, continuation, and compaction

### 2.1 User text, context, and images

- **Surface and recipient:** `src/prompt-loop.ts:2486-2505` and
  `src/interactive-chat-service.ts:1425-1435`; whichever parent or child run is
  being invoked.
- **When it fires:** the task is the last user message; CLI/skill context blocks
  are earlier user messages; image attachments accompany the task or the
  `view_image` follow-up.
- **Claims and truth:** these are operator-, user-, or skill-authored dynamic
  data, not harness factual claims. Their role ordering is exactly the array
  order at `prompt-loop.ts:2490-2505`.
- **Disposition:** **keep**. The provenance distinction matters: skill context
  is a user-role context block, not a system message.

### 2.2 Durable transcript replay

- **Surface and recipient:**
  `src/interactive-chat-service.ts:1417-1455,1475-1485`; console parent.
- **When it fires:** every later turn and every resumed session replays prior
  system, user, assistant, tool, and continuation items before adding the new
  user message.
- **Claims and truth:** replay itself makes no new claim, but every old tool
  output and error remains a prompt surface on all later turns. The service
  suppresses duplicate UI events without suppressing model history, as the code
  states (`interactive-chat-service.ts:1437-1485`).
- **Disposition:** **keep**; treat prompt fixes as forward-only for existing
  durable sessions unless an explicit migration is designed.

### 2.3 Provider continuation and compaction

- **Surface and recipient:**
  `src/model/responses-protocol.ts:73-90,130-232,407-408` and
  `src/model/openai-compatible-gateway.ts:493-519`; parent or child using the
  Responses protocol.
- **When it fires:** provider reasoning/native-search continuation items are
  replayed; above the configured threshold the provider may replace all earlier
  context with an encrypted compaction item.
- **Claims and truth:** the harness correctly treats a compaction item as
  superseding earlier non-system input (`responses-protocol.ts:205-224`) while
  rebuilding system instructions verbatim from the whole transcript
  (`:199-203`). The compacted history's semantic faithfulness is
  provider-controlled and cannot be checked from the encrypted payload.
- **Disposition:** **keep**, but measure long-session adherence to facts learned
  from earlier user/tool turns separately; those facts, unlike the system
  prompt, can survive only inside provider-side compaction.

## 3. Subagent system prompts

### 3.1 Common profile prompt

- **Surface and recipient:** `src/prompt-loop.ts:1099-1172,1246-1260`; every
  child profile.
- **When it fires:** every successful `delegate_task` dispatch.
- **Claims and truth:** fresh context and task/context-only history are **true**
  (`src/prompt-loop.ts:4010-4025`); nested delegation is unavailable because
  children receive `allowedSubagentProfiles: []`
  (`src/prompt-loop.ts:3919-3942`); tool, host-tool, skill, script, browser-lease,
  sandbox-directory, and structured-return lines are generated from the exact
  profile config and lease (`src/prompt-loop.ts:1114-1172,1246-1260`). No live
  drift was found at fixed-literal/control-flow depth.
- **Disposition:** **keep**.

### 3.2 Browser profile

- **Surface and recipient:** `src/prompt-loop.ts:1115-1147` plus
  `src/contracts/subagent.ts:53-59,89-98`; browser child.
- **When it fires:** a browser-profile delegation, with lease-specific login
  and profile-mode lines.
- **Claims and truth:** available actions, one-action calls, lease attachment,
  no-login warning, page distrust, and no workspace write from observations
  match `src/tools/browser.ts:111-209` and the profile tool set. Surveyed at
  descriptor, lease-branch, and profile-config depth; no drift found.
- **Disposition:** **keep**.

### 3.3 Web-fetch and web-search profiles

- **Surface and recipient:** `src/prompt-loop.ts:1230-1244` and
  `src/contracts/subagent.ts:60-64,269-279`; corresponding child.
- **When it fires:** a `web_fetch` or `web_search` delegation.
- **Claims and truth:** web-fetch receives only `web_fetch`; web-search receives
  no built-in tools and the Google native model tool. Local reads, writes,
  browser, nested delegation, and cross-profile tools are absent. Surveyed at
  profile-config and gateway-declaration depth; no drift found.
- **Disposition:** **keep**.

### 3.4 Pattern-author profile: build, search, composition, and publishing

- **Surface and recipient:** `src/prompt-loop.ts:1174-1228`; pattern-author
  child.
- **When it fires:** every pattern-author delegation. Lines 1196-1199 alone are
  removed by `--no-child-composition-guidance`.

| Lines | Claim or instruction | Current-main verdict and evidence | Disposition |
| --- | --- | --- | --- |
| 1176 | Author source, run it in the configured space, return the result reference; an unrun pattern is not an answer. | **True.** The child shares the parent's fabric session (`prompt-loop.ts:3825-3835`), owns `run_pattern`, and the return contract requires its reference (`contracts/subagent.ts:239-267`). | **Keep.** |
| 1177-1181 | Return only reference, inert description, and hashtags; never source; source remains in child/space and reuse goes through index. | **True.** The profile return schema has no source field and owns its contract (`contracts/subagent.ts:213-267`); free strings are sanitized before the parent (`prompt-loop.ts:4033-4082`). | **Keep.** |
| 1182-1183 | Build atoms, decompose larger work, and compose last because small compile loops converge better. | **Heuristic, not universally true.** It is consistent with the profile's 24-turn budget (`contracts/subagent.ts:28-35`) but the failure causal language is absolute. | **Keep the decomposition instruction; fix** the compile-loop law into a tradeoff. |
| 1186 | Search before authoring; if a published pattern already does the job, run it by ID. | **True and important.** `run_pattern` fetches indexed source host-side and returns a live reference (`tools/run-pattern.ts:987-1031`). | **Keep.** This is the correct “when not to compose” half. |
| 1187 | Search whole, then verbs, then scaffolds; matching is ranked/disjunctive and closeness is `matchedTerms/queryTerms`. | **Partly true, incomplete.** Ranking/ratio are true, but the denominator is stopword-free and the endpoint now reports `quality` and `kind` on every result (`pattern-index@c48e61d functions/src/handlers/search-patterns.ts:232-305`). The harness drops both (`src/pattern-index/client.ts:31-48`; `src/tools/search-patterns.ts:236-251`). | **Fix** after surfacing `kind`/`quality`. |
| 1188 | When search is empty, removing words broadens it; adding words cannot. | **Drifted.** One matching content term is already sufficient, so removing unmatched terms cannot create a hit; reformulating with a synonym can (`pattern-index@c48e61d functions/src/handlers/search-patterns.ts:232-264`). | **Fix** to use short content terms, capability verbs, and synonyms; avoid generic filler. |
| 1196 | Every result has import specifier and argument/result shapes; source is unnecessary. | **Mixed.** Import and no-source are true; shapes are fetched only for the leading five (`tools/search-patterns.ts:217-251`). | **Fix.** |
| 1197 | Imported patterns are fetched/compiled first, so composition costs only an import line and nothing else. | **Drifted absolute.** The harness materializes every dependency host-side before the parent compile, which has fetch and compile cost (`tools/run-pattern.ts:1039-1067`). It does save model authoring/source tokens. | **Fix** to state the actual cost advantage. |
| 1198 | Calling an import places its result in an object field or renders its UI in JSX. | **True** in the current live composition fixture (`integration/pattern-index-live.integration.test.ts:99-124`) and render-gate composition fixture (`test/run-pattern-publish-gate.test.ts:122-133`). | **Keep.** |
| 1199 | A search hit is a component to wire, never a specification or whole answer. | **False after `kind`.** The endpoint explicitly classifies object-argument entries as parts and absent/false-argument entries as apps (`pattern-index@c48e61d functions/src/handlers/search-patterns.ts:102-143`). | **Fix** with the when-not-to-compose edge. |
| 1202-1204 | Successful authored source with a description is recorded; no description publishes nothing; hashtags/descriptions support later evaluation and possible discovery. | **True if index publication is enabled.** The full gate is source-authored + client + ledger + publish enabled + non-empty description (`tools/run-pattern.ts:1624-1630`); default status is recorded-only (`:1657-1707`). | **Keep**, make the configuration condition explicit and avoid saying the next search sees it. |
| 1209 | Feedback votes teach ranking. | **True.** The tool records `thumbs_up`/`thumbs_down` (`tools/record-feedback.ts:91-157`), weighted +2/-2 by deployed index quality (`pattern-index@c48e61d functions/src/quality.ts:1-23,64-93`). | **Keep.** |

### 3.5 Pattern-author profile: execution and return contract

| Lines | Claim or instruction | Current-main verdict and evidence | Disposition |
| --- | --- | --- | --- |
| 1212 | Source is inline; the profile has no write/edit tools. | **True** (`contracts/subagent.ts:79-87`). | **Keep.** |
| 1213 | A whole-result `computed()`/derived wrapper necessarily creates a session-only piece. | **False.** CT-2123 measured three of five such entries and an exact-shape positive control as durable. The actual guard observes a keyless instantiation (`tools/run-pattern.ts:1215-1222,1283-1307`). | **Fix** to a non-causal smell; let the guard report the observed pointer. |
| 1214 | Compile errors are iteration material, not an answer. | **True.** Authored-source compiler diagnostics return as `compile-error` (`tools/run-pattern.ts:1069-1089`). | **Keep.** |
| 1215 | `read_file`/`bash` are available for docs/source. | **True** (`contracts/subagent.ts:79-87`). | **Keep.** |
| 1216-1217 | Supplied references are addresses; wire them as inputs; `describe_handle` returns shape, not value. | **True** (`prompt-loop.ts:2835-2855`; `tools/describe-handle.ts:117-187`). | **Keep.** |
| 1218 | `resultSchema` controls disclosed fields; inert scalars can pass, unconstrained strings become address tokens; framework keys need not be declared. | **True** (`tools/run-pattern.ts:1317-1348`; descriptor at `:321-327`). | **Keep.** |
| 1219-1227 | Return last successful reference or the fixed failure branch; never substitute a prior/partial reference. | **True** by the profile-owned discriminated return schema and validator (`contracts/subagent.ts:132-267`; `prompt-loop.ts:1394-1533`). | **Keep.** |

The V1 question remains open. The only V2 measurement explicitly withheld lines
1196-1199; V1—same parent prompt with those four lines restored—has never run
(`docs/history/packages/cf-harness/composition-incentive-2026-08-29.md:245-248`).
Search, publishing, execution, and return guidance should remain regardless.
The four composition lines should neither be deleted as inert nor promoted as
necessary until V1 isolates them.

## 4. Delegation boundary

### 4.1 Tool description and child wrapper

- **Surface and recipients:** `src/tools/delegate-task.ts:14-65` reaches the
  parent; `src/prompt-loop.ts:1263-1278` reaches the child.
- **When it fires:** the descriptor is in every parent turn that offers the
  tool; the wrapper is the child's initial user message.
- **Claims and truth:** fresh context and no parent transcript are **true**.
  “One small component returns a working reference while a whole application's
  compile loop does not converge” is **an over-broad empirical claim**. The
  profile and result-reference claims are true, but “neither the default
  profile nor the parent carries pattern skills” is **configuration-dependent
  and false for a CLI parent explicitly preloaded with those skills**
  (`src/cli.ts:3069-3093`). Pattern-author's profile-owned schema refusal and
  skill-handle host-side injection are true (`src/prompt-loop.ts:3274-3336,
  3970-4001`).
- **Disposition:** **fix** the causal absolutes and add a structured selected-hit
  field. Keep `goal` and `context` for intent and non-index constraints.

### 4.2 What crossed in the 2026-08-31 V2 runs

The audit read the reports in the four V2 measurement directories
(`terra-v2-reuse`, `terra-v2-composition`, `sol-v2-reuse`, and
`sol-v2-composition`) and all 20 parent transcripts they name. Those raw
artifacts are on disk under
`/Users/ben/.bb/worktrees/env_j49cb9z7jg/labs/packages/cf-harness/.cf-harness-console/`;
they are not part of the committed measurement copy. For every delegation, the
census compared `goal` plus `context` by exact string inclusion with every
preceding `search_patterns` hit in that parent run. The two anomalous examples
are Sol composition runs `40fa552f-31ea-439f-b05f-0e38b63ac60d`
(`team-picker`) and `381fbdfb-754a-4ff5-b550-cee302c01c45`
(`workout-streak`).

| Handoff fact | Count |
| --- | ---: |
| Total V2 delegations | 24 |
| Delegations following index search and naming a prior hit | 22 |
| Such delegations carrying the exact selected description | 4 |
| Carrying the exact import hint | 8 |
| Carrying an exact argument shape | 1 |
| Carrying an exact result shape | 0 |
| Delegations not naming a prior hit | 2 |

The two without a prior hit were final compositions of child result handles,
not failed index handoffs. Thus every index-related delegation copied an ID,
but almost all dropped the shapes the parent had just been told to use. One Sol
team-picker goal literally contains `dZ? NO: use patternId bcj...`, showing
self-correction residue crossing as instruction. One workout-streak context
asserts that an unsurfaced field was intended as writable state—an inference,
not search metadata.

This boundary is the mechanism behind V2's effect: the harness automatically
passes only `goal`, optional `context`, and return schema
(`src/prompt-loop.ts:1263-1278,4010-4025`). Search findings are never attached.
The parent voluntarily retypes whatever it remembers into free text.

- **Disposition:** **move** selected search metadata into a structural
  attachment. The parent should choose, not flood, hits: for example
  `selectedPatterns: [{patternId, intent: "run-whole" | "compose-part"}]`.
  The harness should rehydrate the trusted search record into a generated child
  context carrying ID, `kind`, description, import hint, argument/result shapes,
  quality, and match ratio. Free prose remains for the task. This preserves the
  parent's planning decision while removing lossy copying and contradiction
  residue.

## 5. Skill prompt injection

- **Surface and recipients:** `src/skills/registry.ts:814-905`,
  `src/cli.ts:3069-3093`, and `src/prompt-loop.ts:3970-4025`; configured CLI
  parent and configured/profile/handle-skilled children.
- **When it fires:** registry skills are loaded by explicit names; profile
  skills are best-effort filtered to registry presence; `skillHandle` text is
  resolved host-side and injected beside profile context.
- **Claims and truth:** precedence and non-authorization preamble, skill name,
  source, directory, relative-path rule, resource index, and handle source are
  true by construction (`registry.ts:831-850,870-905`). A handle-delivered skill
  has no resources or scripts (`registry.ts:814-821`). The child return is
  scrubbed against the injected text before it reaches the parent
  (`prompt-loop.ts:4033-4082`). Surveyed at injection, activation, resource, and
  return-scrub depth; no live drift found.
- **Disposition:** **keep**; survey only, as directed.

## 6. Tool descriptions

All registered tools are enumerated at `src/tools/registry.ts:19-35`. A tool
description is a behavioral promise because it is sent on every turn in which
the tool is allowed (`src/prompt-loop.ts:2665-2671`).

### 6.1 Search patterns

- **Surface and recipients:** `src/tools/search-patterns.ts:80-151`; parent or
  pattern-author child with an index.
- **When it fires:** every model turn offering `search_patterns`.
- **Claims and truth:** the hashtag description is **drifted for multiple
  tags**: the endpoint uses Firestore `array-contains-any`, not “must carry” all
  (`pattern-index@c48e61d functions/src/handlers/search-patterns.ts:194-202`).
  Text is matched against descriptions, keywords, and tags; matching is
  disjunctive and ranked; ratio fields are true. “More words widen the net” is
  **misleading drift**: the new matcher removes English function words, matches
  word boundaries with light morphology, and accepts one content term
  (`pattern-index@c48e61d functions/src/handlers/search-patterns.ts:104-136,
  232-264`). Extra generic content words can add unrelated OR hits, not useful
  coverage. The endpoint's second change returns `kind` and `quality` on every
  hit and uses both in ranking (`:258-305`), but the harness client does not
  type them (`src/pattern-index/client.ts:31-48`) and the tool strips them
  (`src/tools/search-patterns.ts:236-251`). “Each pattern's declared shapes” is
  false for ranks 6-10 (`:217-251`). Source withholding is true.
- **Disposition:** **fix** the query description; add `kind` and `quality` to
  client/tool output; state that shapes are available only when fetched. This
  is required before the parent can reliably apply the when-not-to-compose
  rule.

Suggested text:

> Search for any supplied hashtag and for stopword-free whole words in
> descriptions, keywords, and hashtags.
> Use a short set of distinctive capability words; one matching term can
> surface a result, and adding generic words adds distant OR matches. Results
> report their stopword-free match ratio, evidence quality, and whether the
> published argument schema classifies them as a reusable `part` or whole
> `app`.

### 6.2 Run pattern

- **Surface and recipients:** `src/tools/run-pattern.ts:285-430`; parent or
  child offered a fabric session.
- **When it fires:** every such model turn.
- **Claims and truth:** compile/run, live result reference, exactly one of
  source/ID, host-side index fetch, unregistered piece, `assign_slug`, source
  limit, live input references, schema-controlled disclosure, and publication
  conditions are **true** (`tools/run-pattern.ts:870-1051,1215-1247,
  1317-1348,1609-1724`). “A whole derived wrapper creates a piece no other
  runtime can load” is **false as a predictive rule** per CT-2123; only the
  observed keyless pointer is authoritative (`:1283-1307`).
- **Disposition:** **fix** the `sourceText` description and the matching child
  prompt/error. Keep the actual post-instantiation guard.

Suggested text:

> Return a durable result object directly. A whole-result derived wrapper is a
> known smell, but not a deterministic failure: after the run the harness
> checks the actual pattern pointer and refuses any piece materialized under a
> session-only identity.

### 6.3 Delegate, slug, handle, and feedback

| Tool surface | Claims and checked implementation | Verdict | Disposition |
| --- | --- | --- | --- |
| `delegate_task`, `src/tools/delegate-task.ts:14-65` | Fresh context, profile choice, return schema, skill handle, and pattern-author return channel are implemented at `src/prompt-loop.ts:3201-3336,3726-4025`; causal small-vs-whole and parent-skill claims are over-broad as described in section 4. | **Mixed/drifted.** | **Fix** and add selected-hit attachment. |
| `assign_slug`, `src/tools/assign-slug.ts:59-95` | Registers once, assigns named URL, validates slug, and refuses a name already resolving to another piece (`:100-198,200-280`). | **True.** | **Keep.** |
| `describe_handle`, `src/tools/describe-handle.ts:84-115` | Returns token knowledge, recorded/declared schema and path; it syncs metadata/schema but never returns the referent value (`:117-187`). | **True.** | **Keep.** |
| `record_feedback`, `src/tools/record-feedback.ts:37-89` | Records up/down as `thumbs_up`/`thumbs_down` (`:91-157`); deployed ranking weights them +2/-2 and excludes net-negative hits by default (`pattern-index@c48e61d functions/src/quality.ts:1-23,64-93`). | **True.** | **Keep.** |

### 6.4 Workspace, browser, web, and skill tools

These were surveyed at descriptor/schema, dispatch, path/lease restriction, and
model-bound output depth. No live drift was found.

| Tool surface | Recipient and firing condition | Factual check | Disposition |
| --- | --- | --- | --- |
| `bash`, `src/tools/bash.ts:65-95` | Any run offering sandbox shell. | VM/current-directory execution and structured streams are implemented at `:97-190`; output mediation/truncation is at `src/prompt-loop.ts:1733-1840,3675-3686`. | **Keep.** |
| `read_file`, `src/tools/read-file.ts:36-65` | Any run offering structured reads. | Workspace resolution, artifact-root refusal, byte bound, and structured errors at `:80-130`; CFC status redaction at `src/prompt-loop.ts:1666-1697,3501-3531`. | **Keep.** |
| `write_file`, `src/tools/write-file.ts:46-75` | Authorized write-capable run. | Replace/append and parent creation at `:78-145`; direct-command authorization at `src/prompt-loop.ts:2200-2240`. | **Keep.** |
| `edit_file`, `src/tools/edit-file.ts:638-697` | Authorized edit-capable run. | Exact replacement/digest behavior begins at `:700-735`; CFC error redaction at `src/prompt-loop.ts:1700-1721,3533-3563`. | **Keep.** |
| `view_image`, `src/tools/view-image.ts:46-103` | Run with image-capable model/tool allowance. | PNG/JPEG/GIF/WebP workspace checks and attachment at `:105-175`; the next user message is generated at `src/prompt-loop.ts:3452-3465`. | **Keep.** |
| `browser`, `src/tools/browser.ts:111-209` | Browser child with lease. | Actions, refs, handle binding, allowlisted origins, and page distrust are enforced in the same module's parsers/lease dispatch (`:211-620`). | **Keep.** |
| `web_fetch`, `src/tools/web-fetch.ts:93-147` | Web-fetch child. | Public HTTP(S), redirect revalidation, bounds, and no cookies/ambient state are implemented at `:149-430`; model output reduction at `src/prompt-loop.ts:3565-3568`. | **Keep.** |
| `read_skill_resource`, `src/tools/read-skill-resource.ts:54-113` | Run with a persisted registry. | Registry-only, relative path, size/binary metadata fallback, and digest checks at `:300-449`. | **Keep.** |
| `run_skill_script`, `src/tools/run-skill-script.ts:82-135` | Profile with explicit script allowlist. | Activated-skill, exact path/digest, execution target, workspace CWD, and lease constraints at `:960-1142`. | **Keep.** |

Native provider search is declared separately from built-ins for the web-search
profile (`src/contracts/subagent.ts:269-279`) and produces provider continuation
behavior rather than a harness tool result. The harness persists only final
assistant text/tool calls plus opaque reasoning and compaction continuation
items (`src/model/responses-protocol.ts:69-123,380-425`), not a model-facing
native-search result string of its own. Surveyed at declaration/protocol depth;
no drift found.

## 7. Tool output, refusals, and prompts for the retry

### 7.1 Generic tool-output path

- **Surface and recipients:** `src/prompt-loop.ts:3390-3475,3478-3704`; the
  model that made the call.
- **When it fires:** after every non-fatal tool call. Raw output is first CFC
  mediated, then handle-swapped and JSON-serialized as a tool message. Images
  add a generated user message.
- **Claims and truth:** the generated image line accurately names the model
  path and output ID (`:3452-3465`). Bash/read truncation accurately gives the
  omitted character count and retained output ID (`:1780-1863`). Run-pattern
  strips raw values, causes, piece ID, and inline schema, leaving the handle and
  sanitized value (`:3570-3594`). No live drift was found at mediation branch
  depth.
- **Disposition:** **keep**.

### 7.2 Invalid calls and authorization refusals

- **Surface and recipients:** `src/contracts/invalid-tool-call.ts:54-80` and
  `src/prompt-loop.ts:2899-3271`; calling model on its next turn.
- **When it fires:** unknown tool, invalid JSON/object/field, disallowed tool or
  subagent profile, or bad/empty skill handle.
- **Claims and truth:** expected tool list is generated from actual allowance
  (`prompt-loop.ts:2992-3009`); field/type expectations come from parsers; tool
  and profile denial name the actual canonical tool/profile (`:3050-3100,
  3223-3271`). Rejected values are deliberately not echoed. These are accurate,
  bounded retry prompts.
- **Disposition:** **keep**. This structured “observation + expected shape” is
  the model for other errors.

### 7.3 CFC observation and file-status refusals

- **Surface and recipients:** `src/contracts/observation.ts:13-52` and
  `src/prompt-loop.ts:1562-1575,1733-1884,2200-2295,3495-3563,3620-3673`;
  calling model.
- **When it fires:** policy denies a call/output, requires opaque pass-through,
  or redacts filesystem/edit status.
- **Claims and truth:** mode/direct-command messages are generated from the
  branch that enforced them (`prompt-loop.ts:2200-2295`). Stream/exit-code and
  file/edit messages state only the observation class that was withheld and
  attach an opaque handle where available (`:1733-1884,3495-3563`). No live
  drift found at policy-branch depth.
- **Disposition:** **keep**. They are prompts for replanning, not mere logs.

### 7.4 `run_pattern` validation, compile, and runtime errors

- **Surface and recipients:** `src/tools/run-pattern.ts:498-515,845-1171,
  1248-1465`; calling model.
- **When it fires:** invalid source/ID pairing, unavailable service, oversize
  source, bad schema/input, lookup/materialization/compile/start failure,
  session-only pointer, missing/failed result, CFC refusal, or convergence
  episode.
- **Claims and truth:** validation and configuration messages directly reflect
  guards (`:870-923,946-985`). Index lookup/materialization/compile messages
  correctly distinguish source the model authored from indexed source it must
  not see (`:987-1089`). Argument mismatch messages name actual declared keys
  and validator failure (`:1091-1171`). Startup and generic computation errors
  correctly withhold possibly sensitive thrown text (`:1248-1263,
  1412-1425`). The convergence message is limited to attributed episodes and
  states cycle/non-idempotence as a possible shape (`:1427-1465`).
- **Disposition:** **keep**, except the keyless message at `:1297-1307`:
  **fix** it to report only the observed session-only identity and a
  non-exclusive remediation. The current message turns the CT-2123 hypothesis
  into a false diagnosis and can cause the next attempt to rewrite valid code.

### 7.5 Actionable CFC commit refusal (CT-2077)

- **Surface and recipients:** `src/tools/run-pattern.ts:503-515,596-698,
  1364-1410`; calling model after a refused commit.
- **When it fires:** `CfcCommitRefusalError` is attributed to the created piece
  and its structured refusal details can be mapped to supplied input keys.
- **Claims and truth:** **true.** Runner details name gate, sink/target,
  offending atoms, reads, and completeness by structural equality
  (`packages/runner/src/cfc/refusal-detail.ts:43-197`). The harness maps reads to
  exact input keys and distinguishes complete, partial, and no attribution
  (`tools/run-pattern.ts:596-698`). The retry prose names the sink and safe
  scalar atoms, states whether dropping named inputs clears or merely narrows
  the flow, and withholds raw document/label detail. This is the fix CT-2077
  asked for.
- **Disposition:** **keep**. It is the strongest retry prompt in the stack:
  observed cause, structured facts, calibrated remedy, and explicit limits.

### 7.6 Publication and index-gate messages

- **Surface and recipients:**
  `src/pattern-index/publish-render-gate.ts:194-216` via
  `src/tools/run-pattern.ts:1657-1669`; pattern author after a successful
  source-authored run with publication enabled.
- **When it fires:** a publication is recorded/discoverable, rejected by the
  render probe, or superseded in the session ledger.
- **Claims and truth:** recorded-only, discoverable, no-UI, default-toString,
  empty render, probe failure, and supersession statements match their verdict
  branches (`tools/run-pattern.ts:1570-1607,1657-1709`; render-gate reasons at
  `publish-render-gate.ts:218-244`). The messages carefully distinguish evidence
  from correctness. No drift found at verdict/control-flow depth.
- **Disposition:** **keep**.

### 7.7 Other tool errors

File, browser, web, skill, slug, handle, search, and feedback tools return
structured errors from their actual validation/dispatch branches. They were
surveyed for claims about configuration, paths, digests, lease/origin, index
availability, and accepted enum values. No live drift was found beyond the
search descriptor already recorded. Keep them. Dynamic upstream error text is
data, not a harness factual claim; where it may carry protected or indexed
source, the model-facing path withholds or scrubs it as described above.

The max-turn error at `src/prompt-loop.ts:2823-2832`, provider failures at
`:2688-2702`, and fatal tool infrastructure failures at `:3385-3405` terminate
the loop. They are artifacts/operator errors, not prompts for a retry, because
no next model turn receives them.

## 8. Child return to parent

- **Surface and recipients:** `src/prompt-loop.ts:1280-1533,4033-4150` and
  `src/contracts/subagent.ts:304-351`; parent.
- **When it fires:** every completed, failed, invalid-return, or interrupted
  child.
- **Claims and truth:** return policy accurately excludes transcript/raw failure
  records while including summary, sanitized run state, and manifest. Pattern
  author success/failure is validated against the profile schema; validation
  failure and declared failure are explicitly named (`prompt-loop.ts:1394-1533`).
  Handle-delivered skill text is scrubbed from returned text before the parent
  sees it (`:4033-4082`). Surveyed at schema, sanitizer, summary, and manifest
  depth; no live drift found.
- **Disposition:** **keep**.

## 9. Contradictions now in context

1. **Parent says import; child says run whole hits.** V2 line 9 says a child
   handed an ID composes it. Child line 1186 says an existing pattern that does
   the job should be run by ID. Both can enter the same run; the parent wording
   is what induces application wrappers.
2. **Parent says later search will find the run; publication says it will not.**
   V2 line 13 promises discoverability, while every default publication reply
   says “NOT offered to search” (`publish-render-gate.ts:202-203`).
3. **Search says every hit has shapes; the tool omits them after rank five.**
   V2 line 3, child lines 1196/1198, and the tool overview all imply universal
   shapes; implementation fetches five (`search-patterns.ts:27-35,217-251`).
4. **Search endpoint says part/app; harness erases the distinction.** The
   deployed endpoint returns `kind` for every hit and tie-breaks parts before
   apps; the tool schema/output knows neither. The prompt therefore asks the
   model to make a decision while discarding the field built for it.
5. **Three surfaces repeat the same disproved keyless cause.** The run tool
   description (`run-pattern.ts:294-297`), child system prompt
   (`prompt-loop.ts:1213`), and retry error (`run-pattern.ts:1297-1307`) state
   CT-2123's rejected law. The actual observed pointer is more reliable than all
   three.
6. **Delegate description says parent lacks pattern skills; CLI may preload
   them.** `delegate-task.ts:35-36` speaks universally, but `--skill` injects
   selected bodies into the parent (`cli.ts:3069-3093`). The profile remains
   the correct owner of pattern execution; the skill claim needs qualification.

## 10. Redesign proposals and verification experiments

Ordered by expected effect:

### 1. Make selected search findings a structured delegation input

Add a parent-chosen selected-hit attachment with an explicit intent
(`run-whole` or `compose-part`); rehydrate trusted metadata into the child
prompt. Do not attach every search result automatically. This removes the
largest unmeasured dependency in V2: the parent's ability to retype an ID and
remember description, kind, shapes, and import information without residue.

**Experiment:** use `scripts/run-measurement-batch.ts` with the committed
`pattern-index-suite.json` and `pattern-index-composition-suite.json`. Hold the
successor parent prompt and child guidance fixed. Run Terra and Sol cells
`terra/free-text-reuse`, `terra/structured-hit-reuse`,
`terra/free-text-composition`, `terra/structured-hit-composition`, and the same
four `sol/*` cells. Primary measures: search-to-delegation selected-hit
fidelity, by-ID whole reuse, distinct tasks/atoms composed, compile errors, and
turns. Falsifier: structured attachment does not improve metadata fidelity or
reduces completion/composition.

### 2. Surface endpoint `kind` and `quality`, then fix search query guidance

Carry both fields through the client and tool output. Teach short,
stopword-free capability terms and synonyms, not “more words widen the net.”
This gives the parent the missing discriminator for whole-app reuse and stops
the prompt from manufacturing low-quality OR hits.

**Experiment:** first run the committed retrieval scorer over its labeled set
with current versus revised model-generated queries, recording hit@5, MRR,
negative-query answer rate, and part/app rank. Then run Terra/Sol cells
`terra/search-old-reuse`, `terra/search-kind-reuse`,
`terra/search-old-composition`, `terra/search-kind-composition` and matching
`sol/*` cells on both committed suites. Primary measures: whole apps run by ID,
parts imported, static mockups wrapped, and searches per task.

### 3. Install a small successor to V2 as the console default

The default should say: search before pattern delegation; distinguish whole
answers from reusable parts; run whole hits by ID; decompose missing behavior;
delegate selected parts; compose last; record truthful descriptions/tags; name
the child return contract. It should not contain CLI workspace-agent prose,
universal compile-loop claims, or a promise that recorded output is immediately
discoverable. Include the when-not-to-compose paragraph from section 1.2.

**Experiment:** reproduce the 2×2 parent-prompt grid on the two committed
suites: `terra/no-parent-reuse`, `terra/default-v3-reuse`,
`terra/no-parent-composition`, `terra/default-v3-composition`, and the matching
four Sol cells. Primary measures: parent searches, by-ID reuse, composition
bar, whole-app wrappers, static-mockup wrappers, compile errors, and completion.
Success requires retaining V2's composition lift while reducing whole-app
wrapping below V2's recorded count.

### 4. Run V1 before changing the child composition four

Keep the rest of the pattern-author prompt. Compare V2's parent prompt with the
four child composition bullets withheld versus restored. This is the named V1
experiment the 2026-08-29 report left open.

**Experiment:** `terra/V2-reuse`, `terra/V1-reuse`,
`terra/V2-composition`, `terra/V1-composition`, and matching Sol cells, using
the same corpus snapshot and both committed suites. Primary measures: imported
atoms, by-ID reuse, whole-app wrappers, compile errors, turns, and completion.
If V1 is indistinguishable or worse across both tiers, delete or collapse the
four bullets; if it adds distinct successful composition without overfire,
keep the minimum causal subset in a follow-up ablation.

### 5. Replace keyless causal prose with observed facts

Change all three CT-2123 surfaces together. The description may name a
whole-result derived wrapper as a smell; the retry must say that this actual run
materialized a session-only pointer, without claiming syntax caused it.

**Experiment:** use CT-2123's five indexed cases plus the object-literal and
exact-shape positive controls as cells `keyless/known-durable`,
`keyless/known-keyless`, `keyless/object-control`, and
`keyless/derived-control`. Record observed pointer and model retry. Success is
zero pre-run false claims and an actionable retry only for the observed keyless
cases.

### 6. Preserve the CT-2077 refusal pattern as the error-message standard

Future retry prompts should expose a structured observation, attribution
confidence, owned input names, and a calibrated remedy, while withholding the
raw protected cause. Do not flatten the current refusal back into opaque prose.

**Experiment:** retain the CT-2077 sink-ceiling cells for `fetchText` and `llm`
with `complete`, `partial`, and `none` attribution, plus unchanged-retry and
drop-named-input replans. Success is correct input naming, no raw document
identifier leakage, and clearing only the cases whose attribution says the
remedy is complete.

### 7. Add prompt-surface drift checks

Tool schemas are API documentation for a model. Add contract checks that the
search client carries all endpoint decision fields, “each result” claims match
actual detail limits, conditional publication prose names its gate, and one
known hypothesis cannot be copied into descriptor/system/error without a shared
source.

**Experiment:** mutation cells in unit tests: remove `kind` from the client,
change the detail limit below max results, flip publication to recorded-only,
and restore the CT-2123 absolute. Each mutation must make a targeted prompt
contract test fail.
