---
name: prototype-name-hazard
description: Audit code for property-name collisions with Object.prototype — `in`, `for...in`, and plain indexing that answer wrong when a data key is named `toString`, `valueOf`, `hasOwnProperty` and friends. Use when auditing membership checks, when a schema/data key meets a record, when a proxy trap answers about own properties, or when something reads back a function where data was expected.
---

# The prototype-name hazard

## The principle

A property name is **data**. `toString`, `valueOf`, `hasOwnProperty`,
`isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString` are legal keys a
pattern author or an external document may use. Every one of them is also an own
property of `Object.prototype`.

So any operation that consults the prototype chain gives the wrong answer about
such a key: `in` reports it present on every object, plain indexing returns the
inherited **function**, and `for...in` enumerates beyond own keys. The hazard is
not the operator — it is **a key whose name comes from data or a schema meeting
a record**. Wherever those two meet, ask whether the question being asked is an
own-property question. It usually is.

## The local fact that makes this bite here

`unsafeObjectKeyIn()` in `packages/utils/src/types.ts` reserves exactly two
names — `__proto__` and `constructor` — at the FabricValue boundary. **Every
other `Object.prototype` member is an ordinary key that stores, round-trips, and
reads back like any other.** So "the data model guards against prototype
pollution" is true and beside the point: the guarded pair is not the dangerous
set here.

The one place prototype-chain semantics are correct is where the question really
is "does this object respond to this name": the `has` trap in
`packages/runner/src/query-result-proxy.ts` keeps `in` deliberately, because
`has` _is_ the `in` operator's own trap. Its `getOwnPropertyDescriptor`
neighbour must not — that pair disagreeing is what took every Loom state-cell
push offline for three days (CT-1949).

## Finding candidates

There is a lint rule, deliberately **not** wired into CI:

```bash
deno lint -c packages/utils/lint-plugins/audit-in-usage.jsonc <paths>
```

It flags `in` with a non-literal key, and `in` with a literal that names a
prototype member. It allows other string literals (discriminated-union
narrowing, which cannot collide) and numeric literals.

**Expect roughly four in five hits to be correct code**, measured across
`packages/runner/src` and `packages/data-model/src`. The dominant legitimate
shape is the array sparse-hole probe — `i in value`, `slot in parent` — where
`in` is the right operator precisely because arrays do not inherit index
properties. That ratio is why the rule is a tool and not a gate: at that signal,
a CI rule would train people to silence it.

So the tool narrows the search; **it does not make the judgement.** For each hit
ask where the key came from. A loop index or a name the code chose itself is
fine. A key from parsed data, a schema's `properties`/`required`, a column name,
or a path segment is the real thing.

## What the tool cannot see

It only knows about `in`. It is blind to the other half, which did the worse
damage: **plain indexing that falls through**. `currentRecord[key]` for an
absent `valueOf` yields `Object.prototype.valueOf`, and handing that to a
comparator threw `Cannot compare a function value` from a public write path — a
write refused because of a method the data never had.

When a hit turns out to be real, look at what the surrounding code does with the
key next. The membership test is usually the symptom; the read beside it is
usually the injury.

## What being wrong looks like

Tells from the two sweeps that found these, offered as seed rather than boundary
— the failure is quiet far more often than loud:

- a schema default silently skipped, so the caller receives a **function** where
  the schema promised a string
- a `required` property satisfied by nothing, so an invalid value is accepted
- a key that cannot be deleted, because the removal pass thinks the new value
  still has it
- a path helper reporting a segment present on an empty object
- a proxy whose `hasOwn` and `ownKeys` disagree, so a read-back value cannot be
  written back — which breaks read-modify-write generally, for every consumer

## Fixing

`Object.hasOwn(obj, key)` for membership; `Object.keys()` in place of `for...in`
when own keys are meant; an own-guarded read where indexing fell through. Where
`in` is genuinely wanted, silence the rule at the line and say which case it is
— the annotation is the record that someone checked.

## Regression protection

`packages/runner/test/prototype-named-properties.test.ts` exercises the surfaces
where this actually bit — defaults, required, removal, writes, path helpers —
using prototype-named keys with ordinary-named controls beside them. It asserts
behaviour rather than syntax, so it has no false positives and nothing to
silence.

When you fix a new instance, prefer extending that file over adding a lint
annotation somewhere. A test that fails when the bug returns is worth more than
a comment saying it was considered once.

History: CT-1949 (the outage), CT-1951 (the class), labs#5357 and labs#5373 (the
fixes).
