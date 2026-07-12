# Direct CFC Exchange Rules

This demo is the canonical copyable form for a module-authored direct policy:

1. Export each static `exchangeRule(...)` declaration.
2. Export one `exchangeRules([...])` set that owns each rule exactly once.
3. Apply it with `Confidential<T, [PolicyOf<typeof rules>]>`.

`cfcPattern` constructs match patterns and may contain `v(...)` or
`THIS_POLICY.subject`. `cfcAtom` constructs concrete runtime atoms; the two
surfaces are intentionally separate.

The compiler binds `PolicyOf` to the defining module export and a canonical
manifest digest. At label creation the runtime binds the concrete owning space
as the policy subject and requires that exact manifest to be installed in the
destination. Missing or mismatched manifests fail closed.

The rule can rewrite only the clause containing its exact module-policy
reference. Sibling and input-derived clauses remain conjunctive and untouched.
`imported-policy.tsx` demonstrates that importing the ruleset retains the
identity of `direct-release.tsx`; a pinned `cf:pattern:<identity>` import
follows the same defining-identity rule.

Run:

```sh
deno task cf check packages/patterns/cfc-exchange-rules/direct-release.tsx --show-transformed --no-run
deno task cf test packages/patterns/cfc-exchange-rules/direct-release.test.tsx
```
