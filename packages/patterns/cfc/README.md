# Shared CFC Pattern Helpers

This directory is the shared authoring library for reusable CFC pattern code.
Start here before copying CFC policy helpers out of an existing demo.

Use these helpers when a pattern needs an established CFC shape:

- `admin.ts` provides generic admin registry, role, and admin-manager credential
  helpers.
- `trusted-action.ts` provides the standard trusted UI action contract types for
  writes authorized by reviewed trusted surfaces.
- `trusted-surfaces/` contains one reusable trusted surface per file. Import
  through `trusted-surfaces/mod.ts` unless a pattern intentionally depends on
  one concrete surface file.
- `prompt-injection/` contains reusable prompt-injection demo helpers: label
  atom builders, text-or-link schemas, safe sub-agent wrapping, prompt event
  conversion, and generic tool builders.

## Import Examples

```ts
import {
  type AdminManagerCredential,
  adminManagerCredentialIsActive,
  adminRegistryEntries,
} from "../cfc/admin.ts";
import type { TrustedActionWrite } from "../cfc/trusted-action.ts";
import { TrustedSaveSurface } from "../cfc/trusted-surfaces/mod.ts";
import {
  promptInputMessage,
  sendMailInputSchema,
  subAgentPattern,
} from "../cfc/prompt-injection/mod.ts";
```

Adjust the relative prefix for nested patterns, such as `../../cfc/admin.ts`
from `packages/patterns/factory-outputs/...`.

## What Stays Local

Keep app-specific policy vocabulary beside the owning pattern:

- concrete label atoms, integrity strings, resource subjects, and value digests
- demo fixtures, hostile or benign sample data, routes, copy, and model choices
- domain-specific role subjects, such as a parking person name or chat profile
- workflow code whose behavior is only meaningful inside one demo

Shared helpers should provide reusable policy structure, not centralize every
policy decision.

## Adding a Shared Helper

Promote code into this directory only when it has a generic name, no local demo
fixture data, and at least one migrated caller. Add focused pattern tests or
`cf check --no-run` coverage for the moved code, then document the helper here.

For the full authoring checklist, read
`docs/common/ai/cfc-helper-authoring-guide.md`.
