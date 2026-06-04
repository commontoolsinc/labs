<!-- @reviewed 2026-06-04 -->

# Skill Fact Audit

A skill's map — canonical homes, exact symbols, file paths — is its
highest-value and highest-rot content (see
[`skill-authoring.md`](./skill-authoring.md), "facts rot — make them testable").
Two mechanisms keep it honest, and they are complementary, not alternatives:

- **Tripwire (deterministic floor).** `deno task check-skill-facts` — a cheap,
  instant, zero-token CI gate that fails if a package or repo path a skill cites
  stops existing. Runs on every PR (the `check` job). Catches _existence_ rot
  only, and deliberately hardcodes nothing.
- **Audit (LLM ceiling).** A periodic / on-change pass that reads a skill against
  the current tree and judges the _semantic_ rot the tripwire cannot see: a
  canonical home that moved or was renamed, advice that is now wrong, a new home
  the skill should mention, framing that has drifted from how the system actually
  works. This half **appreciates** as models improve — at the limit it is the
  more useful of the two.

The auditor is **cf-review itself** — do not build a parallel reviewer. cf-review
already verifies a skill's facts against the tree (it did so unprompted when it
reviewed its own PR). The audit is just cf-review pointed at a skill.

## Triggers

- **On change** — when a PR touches `skills/**`, give it a cf-review pass. (A
  norm today; can become a CI job that runs cf-review on the skill diff once
  agent-in-CI infra is settled.)
- **Periodic** — on a schedule (e.g. monthly), run the prompt below over each
  `skills/**/SKILL.md` and open an issue or fix-PR per drift found. Wire it
  through the repo's scheduled-agent / routine capability.

## Audit prompt

> Read `<skill>/SKILL.md` and audit every load-bearing fact against the current
> tree. For each canonical home, symbol, path, package export, and behavioral
> claim it asserts: is it still true? Has a home moved, been renamed, or been
> removed? Is any "do not" advice stale? Is there a _new_ canonical home or
> footgun the skill should name but doesn't? Does the framing still match how the
> system actually works, and is it still coherent with
> `docs/development/skill-authoring.md`? Verify against the tree (read the code /
> exports) — don't speculate. Report drift as: location · the claim · what is
> actually true now · the one-line fix. If everything resolves, say so and stop.

## Why this isn't all in the tripwire

Deterministic extraction of "is this fact still _true_" from prose is brittle: a
cited path may be skill-local rather than repo-root, a token may be illustrative
(`cf-{name}.figma.ts`), and the worst case — "the home moved but both old and
new names still exist" — is invisible to a grep. The tripwire stays narrow on
purpose; the audit carries the judgment.
