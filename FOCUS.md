Current focus:

- Harden SES verification by rejecting raw top-level helper call results unless
  wrapped in `__ct_data()`.
- Freeze authored AMD module exports to prevent mutable local-module namespace
  state from leaking across invocations.
- Keep a follow-up task open to deduplicate duplicated verifier policy and CLI
  callable execution/input parsing code.
