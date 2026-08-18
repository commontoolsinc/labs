# Agent Harness Conformance

Status: draft 0.1

Conformance is an evidence-backed claim about a named implementation version,
not a synonym for “supports similar features.” Because these specifications are
draft, current profiles are expected to contain explicit deviations.

## Conformance classes

| Class         | Required clauses                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Core batch    | `AH-INV-*`, `AH-CAP-*`, `AH-LIFE-*`, `AH-TOOL-*`, `AH-CONT-*`, `AH-REF-*`, `AH-OBS-*`, `AH-ART-*`, `AH-USAGE-*`, `AH-DIAG-*` |
| Delegation    | Core batch plus `AH-DEL-*`                                                                                                   |
| Interactive   | Core batch plus `AH-INT-*`                                                                                                   |
| CFC transport | Core batch plus `AH-CFC-*`                                                                                                   |

An implementation MAY claim multiple classes. It MUST NOT claim an optional
class merely because it parses related configuration.

## Implementation profile

A conformance statement MUST include:

1. implementation name, version or commit, and profile date;
2. claimed conformance classes;
3. machine-readable capability-probe command and schema version;
4. model gateway, execution substrate, mediator, and adapter trust boundaries;
5. provider, model, credential-owner, authentication-source, billing-route, and
   request-attribution behavior;
6. parent tools and child profiles, including host/network powers and durable
   external-resource semantics;
7. lifecycle, cancellation, context management, and retry behavior;
8. attachment-integrity and model-bound opaque-reference behavior;
9. artifact and resume behavior, including authority-binding validation;
10. usage counters, aggregate coverage, cache semantics, and cost provenance;
11. supported CFC modes and the default selected by each product integration;
12. known deviations and reduced-assurance paths;
13. test or operational evidence for each claimed class; and
14. an owner and retirement condition for every temporary deviation.

## Evidence rules

- Unit tests are appropriate evidence for parsing, policy transitions,
  containment, lifecycle, replay, and artifact invariants.
- Integration tests are required for claims that depend on a real sandbox,
  mediator, browser, network boundary, or process tree.
- A machine-readable capability probe is evidence of interface availability, not
  dependency health or security enforcement.
- Product adapters must state when they narrow, broaden, or select a weaker
  profile than the package default.
- Usage and cost tests must cover missing counters, descendant aggregation,
  provider-specific cache semantics, and incomplete cost evidence rather than
  only the fully populated success case.
- Context-management tests must cover provider compatibility, transcript
  pruning boundaries, tool-call/tool-result pairing, explicit disablement, and
  retry after transient discovery or compaction failure.
- Opaque-reference tests must cover deterministic resume, collisions, malformed
  and unknown tokens, child isolation, and separation of model-facing values
  from raw operator evidence.
- Attachment tests must prove byte stability after source mutation and fail
  closed on missing or tampered retained content.
- Resume tests must reject incomplete, inconsistent, or changed provider and
  credential-owner bindings before provider traffic.
- Historical plans and migration notes are not conformance evidence.

## Current first profile

The first implementation profile is maintained beside `@commonfabric/cf-harness`
in the `labs` repository. It currently characterizes Core batch, Delegation,
Interactive, and CFC transport separately so that experimental interactive
support or reduced-assurance CFC integrations do not overstate the mature batch
runtime.
