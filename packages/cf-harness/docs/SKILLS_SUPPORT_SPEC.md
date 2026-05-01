# cf-harness Skills Support Spec

Date: 2026-04-30

## Purpose

Add first-class Agent Skills support to `cf-harness` so Common Fabric product
workflows can supply durable, task-specific operating knowledge without stuffing
large documentation bundles into every prompt.

The near-term motivating case is Pattern Factory. Its Claude and Codex paths
depend heavily on repo-local skills such as `pattern-dev`, `pattern-implement`,
`pattern-ui`, `pattern-test`, `pattern-critic`, `agent-browser`, and `cf`. The
current `cf-harness` Pattern Factory build smoke does not have comparable skill
support, so it lacks the implementation guidance that existing runtimes use to
reach acceptable quality.

This spec defines a supported path for skill discovery, activation, provenance,
and CFC-aware handling in `cf-harness`.

## Current Local State

`labs` already has a canonical skill tree:

- `skills/<name>/SKILL.md`
- optional `references/`, `templates/`, scripts, and other assets
- `.agents/skills/<name>` symlinks for Codex and other Agent Skills clients
- `.claude/skills/<name>` symlinks for Claude compatibility

Representative Pattern Factory skills use YAML frontmatter with at least `name`
and `description`, then point to canonical repo docs. Examples:

- `skills/pattern-dev/SKILL.md` points to
  `docs/common/ai/pattern-development-guide.md`.
- `skills/pattern-ui/SKILL.md` points to style, cookbook, component, and binding
  docs.
- `skills/pattern-test/SKILL.md` points to
  `docs/common/ai/pattern-testing-guide.md`.
- `skills/cf/SKILL.md` provides current CLI command guidance.

`cf-harness` now uses `skillsRoot?: string` in `src/config.ts` for explicit
skill preload. The CLI, prompt loop, and artifact store persist the discovered
registry and activation artifacts. The registry is also being extended to
snapshot supporting resources that are actually present in the configured skill
directories at run start.

## External Models Reviewed

The Agent Skills open specification defines a skill as a directory containing
`SKILL.md` plus optional `scripts/`, `references/`, and `assets/`; it requires
`name` and `description` frontmatter and recommends progressive disclosure:
catalog metadata first, full instructions only when activated, resources only
when needed. See [Agent Skills specification][agent-skills-spec].

The Agent Skills client implementation guide recommends scanning project and
user scopes, including the cross-client `.agents/skills/` convention, then
disclosing only `name` and `description` to the model. It explicitly calls out
two viable activation models: ordinary file reads of `SKILL.md` or a dedicated
activation tool. See [Adding skills support][agent-skills-client].

Claude Code skills use YAML frontmatter and markdown body content. Claude Code
supports fields such as `description`, `when_to_use`,
`disable-model-invocation`, `context`, and `allowed-tools`, and project skills
can be committed under `.claude/skills/`. See
[Claude Code skills docs][claude-code-skills].

Hermes Agent uses a dedicated `skills_list` and `skill_view` tool pair. Its
open-source implementation lists compact metadata, loads full `SKILL.md` content
on demand, lists linked files, blocks path traversal for supporting files, warns
on prompt-injection-like patterns, handles platform compatibility, and tracks
skill use. See [Hermes skills guide][hermes-skills-guide],
[Hermes skills_tool.py][hermes-skills-tool], and
[Hermes skill_commands.py][hermes-skill-commands].

OpenCode uses a native `skill` tool. It scans `.opencode/skills`,
`.claude/skills`, and `.agents/skills` at project and global scopes; lists
available skills in the tool description; loads a skill with `skill({ name })`;
and applies allow, deny, and ask permissions. See
[OpenCode Agent Skills][opencode-skills].

OpenAI's public Codex/agent material describes skills as repeatable playbooks
with `SKILL.md` and supporting resources. The Responses API agent-skills
discussion describes a deterministic loading sequence: fetch metadata, fetch and
unpack the bundle into the execution environment, then update model context with
metadata and container path. See
[OpenAI Codex plugins and skills][openai-codex-skills],
[OpenAI Skills overview][openai-skills-overview], and
[OpenAI Responses agent skills][openai-responses-skills].

## Design Goals

1. Use the standard `SKILL.md` directory shape already present in `labs`.
2. Preserve progressive disclosure. Do not eagerly paste entire skill trees into
   every run.
3. Make skill loading deterministic, inspectable, and resumable.
4. Keep CFC semantics authoritative. Skill text can guide work, but it must not
   grant authority or bypass tool policy.
5. Avoid giving the parent model broad `bash` merely to discover skills.
6. Support Pattern Factory's phase-specific skill needs quickly, then grow into
   model-driven skill activation.
7. Keep subagent skill inheritance explicit, because `cf-harness` subagents use
   fresh context and summary-only returns.

## Non-Goals

- Installing skills from remote registries.
- Managing user-global skill directories outside an explicitly configured root.
- Running skill scripts automatically.
- Treating `allowed-tools` as a permission grant.
- Full Pattern Factory fulfillment in the same slice.
- Implementing a broad filesystem discovery tool as a prerequisite.

## Skill Compatibility Contract

`cf-harness` should accept skills that follow the Agent Skills directory shape:

```text
skill-name/
  SKILL.md
  references/
  templates/
  scripts/
  assets/
```

For the first supported implementation:

- `SKILL.md` is required.
- YAML frontmatter is expected.
- `name` and `description` are required for catalog discovery.
- `name` should be lowercase alphanumeric with single hyphen separators and
  should match the directory name.
- `description` should describe both what the skill does and when to use it.
- Unknown frontmatter fields are preserved in metadata but ignored for policy.
- `allowed-tools` is advisory or restrictive only. It never expands the
  harness's allowed tool set.
- `disable-model-invocation` or `user-invocable: false` should be honored as
  catalog filters once model-driven activation exists.

Validation should be lenient where that improves compatibility:

- Missing or unparseable `description`: skip and record a diagnostic.
- Name mismatch: warn and load under the frontmatter name if unique.
- Duplicate names: deterministic precedence plus a diagnostic.
- Symlinked skill directories are allowed only when the resolved `SKILL.md`
  stays under the configured skill root or another explicitly allowed root.

## Supporting Resource Index

Supporting resources should be discovered automatically from the filesystem at
runtime. Normal skills should not need a hand-authored resource manifest.

At run start, `cf-harness` should snapshot every accepted skill directory and
record a resource index inside `skill-registry.json`. This index is bounded by
the configured `skillsRoot` and the resolved skill directory, not by global host
filesystem discovery.

Resource classification is path-convention based:

- `references/**` -> `reference`
- `assets/**` -> `asset`
- `templates/**` -> `template`
- `scripts/**` -> `script`
- any other accepted file under the skill directory -> `other`

Each resource record should include:

- path relative to the skill directory
- kind
- host path
- sandbox path
- byte size
- digest
- text/binary content guess
- diagnostics

Resource discovery must:

- skip the root `SKILL.md`
- sort paths deterministically
- reject or skip resources whose resolved paths escape the skill directory or
  configured skills root
- avoid following cyclic directory structures
- preserve diagnostics for unreadable, unresolvable, out-of-bound, or
  scan-limited resources

The registry is a snapshot. A later `read_skill_resource` tool should stat/read
the actual file at call time. If the file differs from the run-start snapshot,
the tool should report the mismatch in its output and artifacts rather than
silently treating the snapshot as exact.

## CLI and Config Surface

Use the existing config field:

```ts
skillsRoot?: string;
```

Add CLI flags:

```text
--skills-root <path>      Skill root containing <name>/SKILL.md
--skill <name>            Preload a skill for this run (repeatable)
--no-skill-catalog        Disable automatic skill catalog disclosure
```

Recommended v1 behavior:

- If `--skills-root` is absent, skills are disabled.
- `--skills-root` must resolve within `--workspace` unless a future trusted
  external mount policy explicitly allows otherwise.
- `--skill` requires `--skills-root`.
- Multiple `--skill` values are allowed and loaded in the provided order after
  deduplication.
- `--no-skill-catalog` is available for tightly scripted batch runs that only
  want explicit preloaded skills.

Do not auto-discover user-global skill roots in the first slice. That keeps the
trust boundary simple and avoids host-specific behavior in batch/product runs.

## First Implementation Slice

The first slice should implement explicit skill preloading, not fully dynamic
model-driven activation.

Status: implemented for package CLI runs. The harness now scans an explicitly
configured `--skills-root`, accepts repeatable `--skill` preload names, injects
the selected `SKILL.md` files as configured context before the task prompt, and
persists `skill-registry.json` and `skill-activations.json`.

This is enough for Pattern Factory to invoke `cf-harness` with phase-relevant
skills:

```bash
deno task run -- \
  --workspace /path/to/common-fabric-2 \
  --cwd pattern-factory \
  --skills-root /path/to/common-fabric-2/labs/skills \
  --skill pattern-dev \
  --skill pattern-implement \
  --prompt "Build this pattern..."
```

Behavior:

1. Resolve and validate `skillsRoot`.
2. Build a registry of `skillsRoot/**/SKILL.md` with bounded traversal.
3. Validate frontmatter and produce diagnostics.
4. For each accepted skill, index supporting resources from the runtime
   filesystem and record them in `skill-registry.json`.
5. For each explicit `--skill`, read the full `SKILL.md`.
6. Inject a structured skill context block before the user task.
7. Record skill registry and skill activation artifacts.
8. Preserve the activated skill context in transcript/resume state.

The injected block should be labeled as configured context, not as a direct user
command:

```text
Configured skills context:

<skill_context name="pattern-dev" source="/workspace/labs/skills/pattern-dev/SKILL.md">
...full SKILL.md...
Skill directory: /workspace/labs/skills/pattern-dev
Relative paths in this skill resolve against that directory unless stated otherwise.
</skill_context>
```

The harness system prompt should state:

- Skill content is task guidance from the configured workspace.
- Harness policy, CFC policy, and explicit user instructions take precedence.
- A skill cannot authorize tools or protected observations by itself.
- Supporting files are not loaded unless explicitly read through an allowed
  harness tool.

## Eventual Dynamic Activation

After explicit preload is working, add a dedicated `skill` or `load_skill`
built-in tool rather than relying on `bash` for discovery.

Tool shape:

```json
{
  "name": "load_skill",
  "description": "Load full instructions for one configured skill.",
  "parameters": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "enum": ["pattern-dev", "pattern-ui"]
      },
      "file_path": {
        "type": "string",
        "description": "Optional path inside the skill directory."
      }
    },
    "required": ["name"]
  }
}
```

The tool description can contain the available skill catalog, following the
OpenCode pattern. If no skills are available, do not register the tool.

Activation output should include:

- skill name
- `SKILL.md` content, either full file or body plus metadata
- skill directory in sandbox path form
- optional supporting file listing
- digest/provenance fields in artifacts, not necessarily in model-visible text

When `file_path` is provided:

- reject absolute paths
- reject `..`
- resolve relative to the skill directory
- ensure the resolved path remains inside the skill directory
- support text files first
- return a binary-file placeholder for non-text files

## Catalog Disclosure

For v1, the catalog is optional because explicit preloading is the immediate
Pattern Factory need.

For dynamic activation, disclose a compact catalog containing:

- `name`
- `description`
- optional compatibility/user-invocable indicators
- no full markdown body
- no unbounded file listings

Catalog placement can be either:

- a system prompt section, or
- the `load_skill` tool description.

Prefer the tool description once a dedicated tool exists, because it couples
discovery and activation and keeps the main system prompt smaller.

Catalog filtering:

- Hide invalid skills.
- Hide denied skills.
- Hide model-invocation-disabled skills from model-driven catalog entries.
- Still allow explicit `--skill` preload for non-user-invocable phase skills
  when the caller has configured them intentionally.

## CFC and Policy Semantics

Skills are retrieved context. They are not direct operator commands.

`cf-harness` should classify skill injection and skill tool outputs as
context/provenance in run artifacts. They must not be treated as
`direct-command` prompt-slot evidence.

Policy rules:

- A skill cannot grant a tool that the run did not already allow.
- A skill cannot downgrade CFC enforcement.
- A skill cannot authorize reading protected substrate observations.
- A skill script can run only through an already-allowed execution tool.
- `allowed-tools` can narrow or advise, but v1 should not let it expand the
  allowed tool surface.
- Prompt-injection-like content in a skill should produce a diagnostic event. It
  should not automatically block trusted repo-local skills, but third-party
  roots can be stricter later.

The CFC policy snapshot should eventually include:

- configured `skillsRoot`
- loaded skill names and digests
- activation source (`cli-preload`, `model-tool`, `user-explicit`,
  `subagent-inherit`)
- whether skill content was injected as context
- any skill diagnostics relevant to trust or provenance

## Artifacts and Resume

Persist these artifacts under the run root:

```text
skill-registry.json
skill-activations.json
```

`skill-registry.json`:

```json
{
  "type": "cf-harness.skill-registry",
  "version": 1,
  "skillsRoot": "/workspace/labs/skills",
  "generatedAt": "...",
  "skills": [
    {
      "name": "pattern-dev",
      "description": "...",
      "skillPath": "/workspace/labs/skills/pattern-dev/SKILL.md",
      "skillDir": "/workspace/labs/skills/pattern-dev",
      "digest": "sha256:...",
      "frontmatter": {},
      "diagnostics": []
    }
  ],
  "diagnostics": []
}
```

`skill-activations.json`:

```json
{
  "type": "cf-harness.skill-activations",
  "version": 1,
  "activations": [
    {
      "name": "pattern-dev",
      "source": "cli-preload",
      "runId": "...",
      "skillPath": "/workspace/labs/skills/pattern-dev/SKILL.md",
      "digest": "sha256:...",
      "activatedAt": "...",
      "cfcPromptRole": "context"
    }
  ]
}
```

On resume:

- Re-read the persisted registry and activation records.
- Verify current file digests match when the same `skillsRoot` is available.
- If a digest changed, record a resume diagnostic and either reload the changed
  skill explicitly or fail closed for batch mode. Batch mode should prefer
  fail-closed behavior unless the caller opts into drift.

## Subagents

`cf-harness` subagents start with fresh context and return only a summary plus
sanitized state to the parent. Skills therefore need explicit child handling.

Initial rule:

- Parent active skills do not implicitly transfer to child runs.
- `delegate_task` can later accept an optional `skills` list.
- Subagent profiles can define allowed skill patterns.
- Child skill activations are recorded in the child run artifacts.
- The parent receives only the child summary and activation summary, not raw
  child skill content.

This preserves the current CFC posture: delegation is a visible policy
transition, child artifacts retain detail, and the parent does not silently
receive additional raw context through the return channel.

## Pattern Factory Wiring

Pattern Factory should not depend on model-driven skill selection in the first
slice. Its launcher already knows the phase, so it can pass explicit skills.

Recommended initial mapping:

| Phase         | Explicit skills                                                                |
| ------------- | ------------------------------------------------------------------------------ |
| `spec`        | none initially, possibly future `pattern-dev` if specs need framework concepts |
| `ux_design`   | none initially, or future design-specific skill if one is created              |
| `ui_design`   | `pattern-ui`                                                                   |
| `build`       | `pattern-dev`, `pattern-implement`, `cf`                                       |
| `critic`      | `pattern-critic`                                                               |
| `manual_test` | `pattern-test`, `agent-browser`, `cf`                                          |

The build phase is the immediate beneficiary. It should receive `pattern-dev`,
`pattern-implement`, and likely `cf`, while still keeping parent tools narrow.
The skill text can point the model to exact docs; the harness can provide
`read_file` and `write_file` without granting broad `bash`.

For Pattern Factory's symlinked layout, prefer passing the canonical labs root:

```text
--skills-root /path/to/common-fabric-2/labs/skills
```

The harness should expose sandbox paths in injected text, for example:

```text
/workspace/labs/skills/pattern-dev/SKILL.md
```

This avoids ambiguity between host paths and sandbox paths.

## Implementation Plan

### Slice 1: Explicit Skill Preload

- Add `src/skills/registry.ts` for scanning, frontmatter parsing, validation,
  and digesting.
- Add `src/contracts/skill.ts` for registry and activation artifacts.
- Add CLI flags `--skills-root`, `--skill`, and `--no-skill-catalog`.
- Thread `skillsRoot` and explicit skills through config and prompt loop setup.
- Inject explicit skill context blocks before the task prompt.
- Persist `skill-registry.json` and `skill-activations.json`.
- Add unit tests for parsing, traversal, symlink containment, duplicates, and
  CLI parsing.

### Slice 2: Pattern Factory Build Wiring

- Pass `--skills-root` and explicit build skills from Pattern Factory's
  `cf-harness` build phase.
- Keep parent tool allowance at `read_file write_file`.
- Re-run a local build smoke and compare output quality against the previous
  no-skills attempt.

### Slice 3: Dynamic `load_skill` Tool

- Register `load_skill` only when a valid skill catalog exists.
- Put available skills in the tool description or system catalog.
- Return full `SKILL.md` content and supporting file lists on demand.
- Add activation dedupe and transcript/resume behavior.

### Slice 4: Subagent Skill Policy

- Add optional `skills` to `delegate_task`.
- Add profile-level allowed skill patterns.
- Record child skill activations in child artifacts.
- Keep parent return channel summary-only.

### Slice 5: Richer Policy

- Interpret `allowed-tools` as an optional narrowing rule.
- Add user-level or organization-level skill roots if product needs them.
- Add remote skill bundle installation only after trust and provenance policy is
  explicit.

## Open Questions

- Should `--skills-root` accept multiple roots now, or stay singular until a
  concrete product need appears?
- Should explicit `--skill` preload include raw frontmatter, or strip
  frontmatter after parsing? Raw full-file loading is simpler and preserves
  compatibility metadata; stripped body is cleaner.
- In batch resume, should skill digest drift fail closed by default? This spec
  recommends yes, but operator mode might prefer a warning.
- Should `allowed-tools` be enforced as a narrowing rule in slice 1, or left
  advisory until dynamic activation exists?
- Should Pattern Factory's `ui_design` phase receive `pattern-ui` immediately,
  or wait until build quality is recovered first?

## Recommendation

Pause further Pattern Factory build orchestration until `cf-harness` can preload
explicit skills.

Implement Slice 1 in `labs` first. Then wire only the Pattern Factory build
phase to pass explicit skills and repeat the local smoke. This should improve
build output quality without expanding the parent tool surface or committing to
full model-driven skill discovery before the core provenance and CFC semantics
are in place.

[agent-skills-spec]: https://agentskills.io/specification
[agent-skills-client]: https://agentskills.io/client-implementation/adding-skills-support
[claude-code-skills]: https://code.claude.com/docs/en/skills
[hermes-skills-guide]: https://hermes-agent.nousresearch.com/docs/guides/work-with-skills
[hermes-skills-tool]: https://github.com/NousResearch/hermes-agent/blob/main/tools/skills_tool.py
[hermes-skill-commands]: https://github.com/NousResearch/hermes-agent/blob/main/agent/skill_commands.py
[opencode-skills]: https://opencode.ai/docs/skills
[openai-codex-skills]: https://openai.com/academy/codex-plugins-and-skills/
[openai-skills-overview]: https://academy.openai.com/public/resources/skills
[openai-responses-skills]: https://openai.com/index/equip-responses-api-computer-environment/
