# Sandboxing specs

These documents define the execution boundary for untrusted pattern code and
the browser posture that supports it.

- [SES sandboxing](SES_SANDBOXING_SPEC.md) is the implementation baseline for
  verified module loading and isolated callback execution.
- [Timing side-channel mitigations](TIMING_SIDE_CHANNELS.md) inventories
  observable clocks and the controls applied to them.
- [Cross-origin isolation posture](cross-origin-isolation.md) records the
  decision not to enable cross-origin isolation.
