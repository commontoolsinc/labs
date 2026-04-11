# Standard Decorators Migration Plan

## Context

The repo currently relies on TypeScript's legacy decorator mode in the root
`deno.json` via `compilerOptions.experimentalDecorators`.

That flag is deprecated. Removing it today is not safe: decorated Lit classes
in the repo fail `deno check` under standard decorator semantics.

This document captures:

- what the migration actually involves
- what a focused spike proved
- how to break the work into reviewable execution phases
- how to validate each step

## Goals

- Migrate repo-owned Lit and `@lit/context` decorator usage off legacy
  decorators.
- Make it safe to remove `experimentalDecorators` from the root config.
- Keep the migration reviewable and mechanically understandable.

## Non-Goals

- Rewriting components away from decorators entirely.
- Large behavioral refactors to component APIs.
- Cleaning up unrelated Deno config warnings in the same work.

## Spike Summary

A focused spike was run against representative files covering:

- plain `@property` / `@state`
- `@query`
- `@consume` / `@provide`
- getter/setter-backed reactive properties

Representative files used in the spike:

- `packages/ui/src/v2/components/cf-draggable/cf-draggable.ts`
- `packages/ui/src/v2/components/form/cf-form.ts`
- `packages/ui/src/v2/components/cf-button/cf-button.ts`
- `packages/iframe-sandbox/src/common-iframe-sandbox.ts`

The spike established that standard decorators are viable here, with a few
important migration rules:

1. `@property` / `@state` / `@query` fields generally need `accessor`.
2. Optional decorated fields cannot stay in `foo?: T` form once converted to
   accessors. They need `foo: T | undefined = undefined`.
3. Getter-backed reactive properties should move the decorator to the setter,
   not keep it on the getter.
4. `@consume` / `@provide` work under standard decorators, but they are stricter
   than the current legacy forms and often need explicit initial values and
   tighter types.
5. Pure Lit files are mechanically simpler than `@lit/context` files, but they
   are still not safe to ship incrementally before the root flag flip. CI
   confirmed that standard-decorator `accessor` syntax in production code does
   not run correctly while the repo is still operating under the legacy root
   config.

## Inventory

Rough source inventory from the spike:

- 72 files under `packages/` contain relevant decorators
- 46 files are pure Lit-style decorator usage
- 23 files use `@lit/context` (`@consume` and/or `@provide`)
- 1 file uses a getter/setter reactive property pattern

Decorator-heavy areas:

- `packages/ui`: 49 files, 231 decorator sites
- `packages/shell`: 18 files, 125 decorator sites
- `packages/iframe-sandbox`: 1 file, 4 decorator sites

Migration sharp edges identified during the spike:

- 55 decorated `declare` fields
- 79 decorated optional fields
- 1 getter/setter reactive property case
- many `private accessor` conversions

## Migration Rules

### Plain reactive fields

Legacy:

```ts
@property({ type: Number })
x = 0;

@state()
private isOpen = false;
```

Standard:

```ts
@property({ type: Number })
accessor x = 0;

@state()
private accessor isOpen = false;
```

### Optional fields

Legacy:

```ts
@property({ attribute: false })
theme?: CFTheme;
```

Standard:

```ts
@property({ attribute: false })
accessor theme: CFTheme | undefined = undefined;
```

### Query fields

Legacy:

```ts
@query("form")
private _form!: HTMLFormElement;
```

Standard:

```ts
@query("form")
private accessor _form!: HTMLFormElement;
```

### Getter/setter-backed reactive properties

Legacy:

```ts
@property()
get src() {
  return this.#src;
}

set src(value: string) {
  ...
}
```

Standard:

```ts
get src() {
  return this.#src;
}

@property()
set src(value: string) {
  ...
}
```

### Context fields

Legacy:

```ts
@consume({ context: cfThemeContext, subscribe: true })
@property({ attribute: false })
declare theme?: CFTheme;
```

Standard shape from the spike:

```ts
@consume({ context: cfThemeContext, subscribe: true })
@property({ attribute: false })
accessor theme: CFTheme = defaultTheme;
```

Note: this is the most important migration boundary. These files should be
treated as a coordinated batch, not mixed piecemeal into otherwise-legacy code.

## Execution Phases

### Prep phase

Objective:

- Finish documentation and add explicit compiler/tooling guard coverage before
  starting the coordinated migration branch.

Scope:

- migration plan documentation
- focused spike artifacts and migration rules
- `js-compiler` guard coverage for TSX inputs with accessor fields
- `ts-transformers` guard coverage for accessor-field AST assumptions

### Coordinated migration phase 1: Low-risk pure Lit files

Good first candidates:

- `packages/shell/src/components/Button.ts`
- `packages/shell/src/components/CFLogo.ts`
- `packages/shell/src/components/Flex.ts`
- `packages/ui/src/v2/components/cf-attachments-bar/cf-attachments-bar.ts`
- `packages/ui/src/v2/components/cf-canvas/cf-canvas.ts`
- `packages/ui/src/v2/components/cf-chip/cf-chip.ts`
- `packages/ui/src/v2/components/cf-resizable-panel-group/cf-resizable-panel-group.ts`
- `packages/ui/src/v2/components/cf-router/cf-router.ts`
- `packages/ui/src/v2/components/cf-scroll-area/cf-scroll-area.ts`
- `packages/ui/src/v2/components/cf-tile/cf-tile.ts`

Characteristics:

- no `@lit/context`
- no getter/setter reactive fields
- little or no optional/accessor edge-case handling

Important constraint:

- These files are still part of the coordinated cutover branch.
- They should not be merged to `main` ahead of the root flag flip.

### Coordinated migration phase 2: Remaining pure Lit files

Objective:

- Finish the bulk mechanical migration before touching context files

This batch includes:

- optional decorated fields
- `declare` conversions
- `private accessor` cases
- stacked decorators that are still pure Lit
- the iframe sandbox getter/setter case

Representative files:

- `packages/ui/src/v2/components/cf-draggable/cf-draggable.ts`
- `packages/ui/src/v2/components/cf-question/cf-question.ts`
- `packages/shell/src/views/AppView.ts`
- `packages/iframe-sandbox/src/common-iframe-sandbox.ts`

### Coordinated migration phase 3: `@lit/context` files and config/test cleanup

Objective:

- Convert all remaining context-using files
- remove the root `experimentalDecorators` flag
- clean up config and tests that still depend on legacy-decorator warnings

Representative files:

- `packages/ui/src/v2/components/cf-theme/cf-theme.ts`
- `packages/ui/src/v2/components/cf-modal-provider/cf-modal-provider.ts`
- `packages/ui/src/v2/components/cf-button/cf-button.ts`
- `packages/ui/src/v2/components/form/cf-form.ts`
- `packages/shell/src/views/RootView.ts`

Expected follow-up work in this batch:

- update `scripts/bundle.ts`
- update `packages/shell/felt.config.ts`
- update package-local `deno-web-test` configs still forcing legacy decorators
- update tests that currently assert the deprecation warning text

### Root flag flip

This is the cutover point where the repo stops running in legacy decorator
mode.

Required change:

- remove `compilerOptions.experimentalDecorators` from the root `deno.json`

This should land together with the coordinated migration phases above, not
afterward. The execution phases are still useful for implementation and review,
but they are not safe as independently mergeable releases.

## Validation Plan

### For every execution phase

- `deno check` on touched files
- focused component/package tests where present
- no behavioral refactors mixed into the migration diff

### For the coordinated migration workstream

Maintain a focused test that runs representative files under a generated
standard-decorators config. The spike used this to catch typing and config
issues early before attempting a full flag flip.

Suggested coverage areas:

- plain `@property` / `@state`
- `@query`
- `@consume` / `@provide`
- getter/setter-backed reactive property
- compiler/tooling compatibility for `accessor` fields

### For the root flag flip

- root `deno check` coverage for affected packages
- relevant package tests for `ui`, `shell`, `iframe-sandbox`, and `deno-web-test`
- update tests that explicitly look for the old warning text

## Risks

### Component/runtime risk

The primary risk is in Lit and `@lit/context` behavior, not parsing. The repo
currently type-checks and runs under legacy decorator semantics, and the
migration changes both syntax and runtime expectations for decorated class
members.

### Compiler/tooling risk

The pattern compiler and transformer pipeline do not appear to consume Lit
decorators directly today, but the migration still changes class field syntax
from plain property declarations to accessor-backed declarations.

The spike checked the TypeScript AST shape directly and found that:

- `accessor foo = 1` still parses as a `PropertyDeclaration`
- the node carries an `AccessorKeyword` modifier

That lowers the parser/AST-compatibility risk, but does not eliminate semantic
or tooling risk. Any compiler or transformer code that assumes plain field
semantics could still be affected.

### Specific compiler/tooling follow-up

Before broad rollout, add explicit guard coverage for:

- `packages/js-compiler`: compile a TSX input containing `accessor` fields
- `packages/ts-transformers`: verify no AST assumptions break on
  `PropertyDeclaration` nodes with `AccessorKeyword`

## Recommended Execution Strategy

1. Finish the prep phase first.
2. Build the real migration as one coordinated branch or tightly coupled stack.
3. Use the phases above for implementation order and review structure, but do
   not merge standard-decorator production code to `main` before the root flag
   flip.
4. Remove the legacy root flag in the same coordinated cutover.

This sequencing minimizes risk because:

- the compiler/tooling assumptions get explicit guard coverage first
- the bulk of the file count is in pure Lit conversions
- the hardest part remains isolated to the context boundary
- CI already showed that mixed-mode shipping is unsafe

## Open Questions

- Whether any additional third-party decorators outside Lit / `@lit/context`
  need to be included in the same migration sweep
- Whether some package-local configs should keep legacy decorators temporarily
  even after the root config flips, or whether the goal is a repo-wide cutover
- Whether to build a codemod for Batch 2, or keep it as scripted search/replace
  plus manual review

## Current Recommendation

Proceed with prep only until the compiler/tooling guard tests are in place.

After that, do the real migration as a coordinated cutover that includes the
root flag flip. Do not land Batch 1-style standard-decorator `accessor`
conversions into `main` while the repo is still running under the legacy root
config.
