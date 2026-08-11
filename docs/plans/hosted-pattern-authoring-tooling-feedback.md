# Developer-tooling feedback for hosted authoring

Add a safe way for a hosted authoring agent to report what its development
environment is missing. This is a follow-up to
[`hosted-pattern-authoring.md`](hosted-pattern-authoring.md), not a dependency
of its piece-change or new-space steel threads.

## Status

Not started.

## Goal

The authoring tool set includes `report_developer_tooling_need`. The agent uses
it when a missing or defective capability makes its work slower, less reliable,
or impossible. Reports can cover compiler bugs or poor diagnostics, missing
`cf` behavior, missing Unix tools, documentation gaps, sandbox restrictions,
browser tooling, or anything else needed to produce a good pattern.

The tool records the need. It does not install software, grant a capability,
change the sandbox, publish source, or waive a verification gate. The agent
continues with available tools when possible. A blocked session references the
report in its failure result.

## Plan

- [ ] Add `report_developer_tooling_need` as a mediated `cf-harness` tool. Its
  input contains a category, summary, impact, expected behavior, and minimal
  evidence.
- [ ] Add the authoring session, environment versions, and relevant tool
  invocation identifiers in trusted service code rather than model-authored
  input.
- [ ] Store the full report as a durable session artifact carrying the combined
  CFC labels of its request, evidence, tool results, and session context.
- [ ] Show the local report through the same CFC-checked access as other session
  artifacts.
- [ ] Define a trusted automatic-export projection limited to enumerated
  category and impact values, tool and environment versions, and stable
  diagnostic codes.
- [ ] Reject free text, source, request text, paths, identifiers, commands,
  arguments, and raw results from automatic export.
- [ ] Send the bounded projection to the developer-tooling triage sink only
  after its CFC flow check passes.
- [ ] Require an authorized person's explicit declassification before sending
  a full report or other free text.
- [ ] Test that reporting cannot expand the tool set, change the sandbox,
  publish source, or satisfy a failed verification gate.
- [ ] Test that the full report retains sensitive labels, the projection rejects
  every disallowed field, and permitted diagnostic metadata reaches the triage
  sink only after the CFC check passes.

Success means an agent can report a missing or defective tool without gaining
authority or creating a new path for source, request, or session data to leave.
