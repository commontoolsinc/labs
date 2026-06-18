# Shared CFC Pattern Helpers

This directory is the shared authoring library for reusable CFC pattern code.
Start here before copying CFC policy helpers out of an existing demo.

For a categorized list of reusable primitives, see [INDEX.md](./INDEX.md).

## Use A Trusted Surface

Trusted surfaces wrap an explicit UI action with the CFC event-integrity
contract expected by the runtime. Use one when the user action should be
authorized only from a reviewed surface instead of from arbitrary host UI.

```tsx
import { pattern, UI, Writable } from "commonfabric";
import {
  TrustedSaveSurface,
  type TrustedSaveTitleUiContract,
} from "../cfc/trusted-surfaces/mod.ts";

export default pattern(() => {
  const draftTitle = new Writable("");
  const savedTitle = new Writable<TrustedSaveTitleUiContract>("");
  const trustedSave = TrustedSaveSurface({ draftTitle, savedTitle });

  return {
    [UI]: (
      <cf-vstack>
        {trustedSave}
        <div>{savedTitle}</div>
      </cf-vstack>
    ),
    savedTitle,
    save: trustedSave.save,
  };
});
```

The host pattern owns where the surface appears and how the protected value is
displayed. The shared surface owns the reviewed action, disclosure copy, button,
and CFC write contract.

## Use Admin Helpers

Use `admin/mod.ts` when a pattern has a local notion of "admin" but wants the
common registry shape and helper functions. The pattern still defines its own
subject and integrity labels.

```ts
import {
  type AdminManagerCredential,
  adminManagerCredentialIsActive,
  adminRegistryEntries,
  adminRegistryEveryoneIsAdmin,
} from "../cfc/admin/mod.ts";
import {
  type AddIntegrity,
  type RequiresIntegrity,
  Writable,
} from "commonfabric";

const PROJECT_ADMIN_INTEGRITY = "project-admin" as const;
const PROJECT_ADMIN_MANAGER_INTEGRITY = "project-admin-manager" as const;

interface ProjectAdminRoleAssignment {
  subject: { projectId: string };
  displayName: string;
}

type ProjectAdminRole = AddIntegrity<
  ProjectAdminRoleAssignment,
  readonly [typeof PROJECT_ADMIN_INTEGRITY]
>;

type ProjectAdminList = RequiresIntegrity<
  ProjectAdminRole[],
  readonly [typeof PROJECT_ADMIN_MANAGER_INTEGRITY]
>;

type ProjectAdminManagerCredential = AdminManagerCredential<
  typeof PROJECT_ADMIN_MANAGER_INTEGRITY
>;

const admins = adminRegistryEntries<ProjectAdminRole>(adminRegistry);
const everyoneIsAdmin = adminRegistryEveryoneIsAdmin(adminRegistry);
const canEditAdmins = adminManagerCredentialIsActive(managerCredential.get());
```

Keep subject lookup and local role toggling in the pattern when the domain model
is local, such as people, profiles, rooms, or projects.
`adminRegistryEveryoneIsAdmin` treats an empty admin list as bootstrap mode:
everyone is an admin until the pattern writes at least one explicit admin role
or explicitly stores `everyoneIsAdmin: false`.

## Use Prompt-Injection Helpers

Use `prompt-injection/` when building a CFC demo or workflow that separates
direct user authority from untrusted document influence. The helpers build the
common atoms, schemas, prompt messages, and generic tools while the pattern owns
its specific resource, prompt, fixtures, and routes.

```ts
import {
  confidentialMessagesSchema,
  INJECTION_SAFE_ATOM,
  promptInfluenceAtom,
  promptInjectionRiskAtom,
  promptInputMessage,
  promptSlotBoundAtom,
  sendMailInputSchema,
  subAgentPattern,
  trustedAgentKernelAtom,
  userSurfaceInputAtom,
} from "../cfc/prompt-injection/mod.ts";

const risk = promptInjectionRiskAtom(untrustedResource);
const influence = promptInfluenceAtom(untrustedResource);
const kernel = trustedAgentKernelAtom("agent-kernel-v1");
const userInput = userSurfaceInputAtom(userDid, surfaceName, valueDigest);
const slot = promptSlotBoundAtom(
  promptSource,
  "direct-command",
  "agent-kernel-v1",
  userDid,
  surfaceName,
  valueDigest,
);

const sendSchema = sendMailInputSchema([kernel, userInput, slot]);
const briefingSchema = confidentialMessagesSchema([risk, influence]);
const trustedPromptMessage = promptInputMessage(event);
const requiredIntegrity = [kernel, userInput, slot, INJECTION_SAFE_ATOM];
```

The prompt helpers use the shared CFC atom vocabulary from `commonfabric/cfc`.
Use these builders instead of spelling atom `type` URLs by hand in shared
helpers.

Call shared builders from inside the pattern body unless the value is plain
static data. CFC-authored pattern code cannot use arbitrary top-level call
results in SES mode.

## What Stays Local

Keep app-specific policy vocabulary beside the owning pattern:

- concrete label atoms, integrity strings, resource subjects, and value digests
- demo fixtures, hostile or benign sample data, routes, copy, and model choices
- domain-specific role subjects, such as a parking person name or chat profile
- workflow code whose behavior is only meaningful inside one demo

Shared helpers should provide reusable policy structure, not centralize every
policy decision.

## Adding A Shared Helper

Promote code into this directory only when it has a generic name, no local demo
fixture data, and at least one migrated caller. Add focused pattern tests or
`cf check --no-run` coverage for the moved code, then document the helper in
[INDEX.md](./INDEX.md).

For the full authoring checklist, read
`docs/common/ai/cfc-helper-authoring-guide.md`.
