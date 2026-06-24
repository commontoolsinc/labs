# CFC Helper Authoring Guide

Use this guide when creating or promoting shared CFC helpers under
`packages/patterns/cfc/`.

This guide documents the authoring patterns used by the current shared helpers
so pattern authors can add new helpers without first learning every part of the
CFC runtime.

## Mental Model

CFC helpers are normal pattern code plus policy metadata. The metadata is
carried by TypeScript type aliases from `commonfabric`.

The main pieces helper authors use are:

- `AddIntegrity<T, I>`: the value has additional integrity evidence `I`.
- `RequiresIntegrity<T, I>`: the value may be used only when integrity evidence
  `I` is present.
- `WriteAuthorizedBy<T, typeof handler>`: a writable output may be modified by
  that handler identity.
- `Cfc<T, Metadata>`: attaches explicit CFC metadata that does not have a
  narrower helper alias yet.

For trusted UI actions, two checks matter:

- write authority: the target output type names the handler that is allowed to
  write it
- event integrity: the handler may only be triggered by an event from a trusted
  rendered surface with the required event-integrity labels

The shared `TrustedActionWrite` aliases combine these. The trusted surface
renders matching `data-ui-pattern`, `data-ui-event-integrity`, and
`data-ui-action` attributes so the trusted renderer can bind the click to the
reviewed UI that produced it.

For prompt-injection helpers, treat atoms and schemas as evidence builders, not
as policy decisions. A helper can build atoms like `PromptSlotBound` or
`UserSurfaceInput`, but the caller must supply the user, surface, source, role,
digest, and route-specific integrity requirements.

## Start With The Boundary

Before writing a helper, identify the CFC boundary it supports:

- trusted UI action: a user click authorizes a protected write
- role or registry lookup: local role vocabulary needs reusable storage and
  lookup shape
- prompt/tool boundary: direct user authority must stay separate from untrusted
  document influence
- disclosure or release gate: a value can move only after a reviewed surface
  records the required action

If you cannot name the boundary, keep the code local. Shared CFC helpers should
make policy structure reusable; they should not hide the policy decision.

## Authoring Trusted Action Types

Use the trusted action aliases from `commonfabric` when a helper writes to a
protected output from a specific handler.

```ts
import { handler, type TrustedActionWrite, Writable } from "commonfabric";

export const TRUSTED_REVIEW_SURFACE = "TrustedReviewSurface";
const REVIEW_TITLE_ACTION = "TrustedReviewTitle";

export const reviewTitle = handler<
  void,
  {
    draftTitle: Writable<string>;
    reviewedTitle: Writable<string>;
  }
>((_, { draftTitle, reviewedTitle }) => {
  reviewedTitle.set(draftTitle.get().trim());
});

export type ReviewedTitleWrite = TrustedActionWrite<
  string,
  typeof reviewTitle,
  typeof REVIEW_TITLE_ACTION,
  typeof TRUSTED_REVIEW_SURFACE
>;
```

Use `TrustedActionWriteWithIntegrity` when one surface requires more evidence
than the surface identity alone. Existing examples use this for gates that need
both the trusted surface and an extra review/disclosure/action label.

Use `TrustedActionUiContract<T, Action, Pattern>` when the value itself should
carry the UI contract metadata, usually for fields that are passed around as
reviewed values after the write.

Keep action and surface constants local to the helper file. Export the surface
identity constant; do not export local demo vocabulary as shared policy.

## Authoring Trusted Surfaces

Put one reusable surface per file under
`packages/patterns/cfc/trusted-surfaces/`, and export it from
`trusted-surfaces/mod.ts`.

A trusted surface should contain four pieces:

1. Generic input cells for the local values it edits or displays.
2. Handler functions that perform the protected write.
3. Output types that label protected outputs with `TrustedActionWrite`.
4. UI with matching trusted-event dataset attributes.

```tsx
import {
  computed,
  handler,
  NAME,
  pattern,
  Stream,
  type TrustedActionWrite,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export const TRUSTED_APPROVAL_SURFACE = "TrustedApprovalSurface";
const APPROVE_ACTION = "TrustedApprove";

export const approveReviewedValue = handler<
  void,
  {
    draft: Writable<string>;
    approved: Writable<string>;
  }
>((_, { draft, approved }) => {
  approved.set(draft.get().trim());
});

export interface TrustedApprovalSurfaceInput {
  draft: Writable<string>;
  approved: Writable<string>;
}

export interface TrustedApprovalSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  approved: TrustedActionWrite<
    string,
    typeof approveReviewedValue,
    typeof APPROVE_ACTION,
    typeof TRUSTED_APPROVAL_SURFACE
  >;
  approve: Stream<void>;
}

export const TrustedApprovalSurface = pattern<
  TrustedApprovalSurfaceInput,
  TrustedApprovalSurfaceOutput
>(({ draft, approved }) => {
  const approve = approveReviewedValue({ draft, approved });

  return {
    [NAME]: computed(() => "Trusted Approval Surface"),
    [UI]: (
      <cf-card
        id="trusted-approval-surface"
        data-ui-pattern={TRUSTED_APPROVAL_SURFACE}
        data-ui-event-integrity={TRUSTED_APPROVAL_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted approval</cf-heading>
          <cf-button data-ui-action={APPROVE_ACTION} onClick={approve}>
            Approve
          </cf-button>
        </cf-vstack>
      </cf-card>
    ),
    approved,
    approve,
  };
});
```

The dataset attributes and type metadata must agree:

- `data-ui-pattern` should equal the exported trusted surface constant.
- `data-ui-event-integrity` should include the event-integrity labels required
  by the output contract.
- `data-ui-action` should equal the action string in the `TrustedActionWrite`
  type.

Use generic names and neutral copy. A trusted surface may say what operation it
performs, such as "publish" or "confirm recipient", but it should not mention a
demo fixture, route name, customer, model, mailbox, or app-specific role.

## Authoring Admin Helpers

Admin helpers are for the reusable registry shape, not for a global admin
policy. The local pattern owns the role names, subjects, and integrity labels.

Use this shape when a pattern has:

- a list of role assignments stored in one registry value
- a manager credential that permits editing the registry
- subject equality that should work for cells or structured objects

```ts
// Shown for illustration only.
import {
  type AddIntegrity,
  type RequiresIntegrity,
  type Writable,
} from "commonfabric";
import {
  type AdminManagerCredential,
  adminManagerCredentialIsActive,
  adminRegistryEntries,
  type AdminRegistryValue,
  type AdminRoleAssignment,
  subjectHasAdminRole,
} from "../cfc/admin/mod.ts";

const PROJECT_ADMIN = "project-admin" as const;
const PROJECT_ADMIN_MANAGER = "project-admin-manager" as const;

type ProjectSubject = { projectId: string };

type ProjectAdminRole = AddIntegrity<
  AdminRoleAssignment<ProjectSubject>,
  readonly [typeof PROJECT_ADMIN]
>;

type ProjectAdminRegistry = RequiresIntegrity<
  AdminRegistryValue<ProjectAdminRole>,
  readonly [typeof PROJECT_ADMIN_MANAGER]
>;

type ProjectAdminManager = AdminManagerCredential<
  typeof PROJECT_ADMIN_MANAGER
>;

declare const registry: Writable<ProjectAdminRegistry>;
declare const credential: Writable<ProjectAdminManager | undefined>;
declare const subject: ProjectSubject;

const admins = adminRegistryEntries<ProjectAdminRole>(registry);
const canManage = adminManagerCredentialIsActive(credential.get());
const isAdmin = subjectHasAdminRole(admins, subject);
```

Promote only registry-neutral behavior. Keep local actions like "make parking
captain", "grant room moderator", or "assign project owner" beside the owning
pattern, because those actions define domain policy.

## Authoring Prompt-Injection Helpers

Prompt-injection helpers support a specific CFC distinction: direct user command
authority is not the same as untrusted document influence. Command-like text in
a document remains a labeled source value until trusted runtime evidence binds
it to an accepted prompt slot and route.

Shared helpers should cover repeatable mechanics:

- atom builders for known evidence shapes
- schema builders that encode required integrity
- text-or-link schemas for opaque observations
- prompt event conversion
- tool wrappers that preserve handler types
- sub-agent wrappers that fail closed on malformed result schemas

Do not put hostile fixtures, routes, model choices, mailbox addresses, or demo
resource ids in shared prompt helpers.

### Atom Builders

Atoms are evidence values. Builders should require callers to supply the
policy-sensitive parameters.

```ts
// Shown at module scope.
import {
  promptInfluenceAtom,
  promptInjectionRiskAtom,
  promptSlotBoundAtom,
  trustedAgentKernelAtom,
  userSurfaceInputAtom,
} from "../cfc/prompt-injection/mod.ts";

const kernel = trustedAgentKernelAtom("agent-kernel-v1");
const sourceRisk = promptInjectionRiskAtom(sourceRef);
const sourceInfluence = promptInfluenceAtom(sourceRef);
const userInput = userSurfaceInputAtom(userDid, surfaceName, valueDigest);
const slot = promptSlotBoundAtom(
  promptSource,
  "direct-command",
  "agent-kernel-v1",
  userDid,
  surfaceName,
  valueDigest,
);
```

When adding a new atom helper, mirror the atom registry name and parameters.
Prefer required parameters over optional defaults unless the default is an
official concept URI or a stable shared profile value.

Common atom type URLs and generic builders live in the public
`commonfabric/cfc` module. Shared helpers under `packages/patterns/cfc/` should
import that module instead of spelling atom `type` URLs by hand.

### Schema Builders

Schema helpers should make authority requirements visible at the field that
needs them.

```ts
// Shown at module scope.
import {
  confidentialMessagesSchema,
  sendMailInputSchema,
} from "../cfc/prompt-injection/mod.ts";

const sendSchema = sendMailInputSchema([kernel, userInput, slot]);
const messageSchema = confidentialMessagesSchema([
  sourceRisk,
  sourceInfluence,
]);
```

Use `TEXT_OR_LINK_SCHEMA` when a tool may receive an opaque link instead of raw
text. This lets a workflow pass a protected value through without forcing the
agent to observe the underlying confidential content.

### Sub-Agent Wrappers

The shared `subAgentPattern` parses result schemas and fails closed for invalid
schema inputs. Preserve that rule in new wrappers: an invalid schema should not
be treated like permissive schema `true`.

Keep wrappers generic. The local pattern should supply:

- prompt and messages
- result schema
- tools
- model and token settings
- observation ceiling
- route-specific system prompt

## Promotion Checklist

Create a shared helper only when the code is policy-generic and has clear reuse
value. Good candidates include:

- CFC contract type aliases that encode a recurring trusted UI pattern
- reusable trusted surfaces with domain-neutral inputs and copy
- generic admin registry or credential helpers
- prompt-injection utilities that are not tied to one hostile fixture

Keep code local when it contains:

- app-specific label atoms or integrity strings
- resource subjects, value digests, routes, sinks, or endpoint names
- demo data, hostile or benign fixtures, model choices, or UI copy
- domain-specific role transitions or workflow decisions

Before moving code into `packages/patterns/cfc/`:

1. Name the boundary the helper supports.
2. Verify the helper does not choose local policy for callers.
3. Migrate at least one existing caller.
4. Add the helper to `packages/patterns/cfc/INDEX.md`.
5. Add a usage note to `packages/patterns/cfc/README.md` if it creates a new
   helper category.

## Verification

Use the narrowest meaningful checks:

```sh
deno task cf test packages/patterns/<pattern>/main.test.tsx --root packages/patterns
deno task cf check packages/patterns/<pattern>/main.tsx --no-run
deno fmt --check <touched files>
```

For trusted surfaces, include coverage that exercises the exported stream or
handler path and verifies the protected output changes only through the trusted
surface path.

For admin helpers, cover:

- empty registry defaults
- active and inactive manager credentials
- subject lookup for the local subject shape
- disabled or hidden local admin actions when manager integrity is absent

For prompt-injection helpers, cover:

- generated schemas include the expected required integrity
- text-or-link values are accepted where opaque observations are expected
- malformed result schemas fail closed
- local fixtures remain local after extraction

Broaden to `deno task check` when the helper affects multiple CFC demos or
shared contract types.
