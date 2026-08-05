# Agent Harness Conformance

Status: draft 0.1

Conformance is an evidence-backed claim about a named implementation version,
not a synonym for “supports similar features.” Because these specifications are
draft, current profiles are expected to contain explicit deviations.

## Conformance classes

| Class         | Required clauses                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| Core batch    | `AH-INV-*`, `AH-CAP-*`, `AH-LIFE-*`, `AH-TOOL-*`, `AH-CONT-*`, `AH-ART-*`, `AH-USAGE-*`, `AH-DIAG-*` |
| Delegation    | Core batch plus `AH-DEL-*`                                                                           |
| Interactive   | Core batch plus `AH-INT-*`                                                                           |
| CFC transport | Core batch plus `AH-CFC-*`                                                                           |

An implementation MAY claim multiple classes. It MUST NOT claim an optional
class merely because it parses related configuration.

## Implementation profile

A conformance statement MUST include:

1. implementation name, version or commit, and profile date;
2. claimed conformance classes;
3. machine-readable capability-probe command and schema version;
4. model gateway, execution substrate, mediator, and adapter trust boundaries;
5. parent tools and child profiles, including host/network powers;
6. lifecycle, cancellation, artifact, and resume behavior;
7. usage counters, aggregate coverage, cache semantics, and cost provenance;
8. supported CFC modes and the default selected by each product integration;
9. known deviations and reduced-assurance paths;
10. test or operational evidence for each claimed class;
11. an owner and retirement condition for every temporary deviation.

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
- Historical plans and migration notes are not conformance evidence.

## Current first profile

The first implementation profile is maintained beside `@commonfabric/cf-harness`
in the `labs` repository. It currently characterizes Core batch, Delegation,
Interactive, and CFC transport separately so that experimental interactive
support or reduced-assurance CFC integrations do not overstate the mature batch
runtime.
