# 10. Safety Invariants

The system enforces the following invariants:

1. Confidentiality labels are monotone unless explicitly rewritten by policy.
2. Policy principals propagate by default and cannot be dropped accidentally.
3. Confidentiality exchange requires explicit integrity guards.
4. Side effects and declassification require either:
   - state-scoped authorization, or
   - event-scoped consumable intent consumed at a commit point.
   Minimal control-integrity constraints remain for minting intents and policy-state transitions.
5. Authority-only secrets do not taint responses only when endorsed usage contracts are satisfied.
6. Violating a policy never silently downgrades confidentiality; it disables exchange.
7. **Robust declassification**: Low-integrity inputs cannot influence which data is declassified or where it flows. Intent parameters affecting scope or destination must meet policy-defined integrity thresholds (see [§3.8.6](./03-core-concepts.md#386-integrity-requirements-for-intent-parameters-robust-declassification)).
8. **Transparent endorsement**: High-confidentiality data cannot influence which inputs get endorsed (upgraded to high integrity). Endorsement decisions must not branch on secret comparisons (see [§3.8.7](./03-core-concepts.md#387-transparent-endorsement)).
9. **Flow-path confidentiality**: The path by which data arrives (not just the data content) carries its own confidentiality. An output tainted by high-confidentiality input is itself high-confidentiality, even if the output value is public.

---

## Attack Examples

### Router Attack (Encoding in Control Flow)

Consider a trusted component `to_city(location) → city_name` that reduces location precision for privacy:

**Naive approach** (broken):
- Input: `location` with label `{ confidentiality: [HighPrecision] }`
- Trusted component endorses output as `LowPrecision`
- Policy allows `LowPrecision` to declassify to `Public`

**Attack**: An adversary interposes an "evil router" that:
1. Takes the high-precision location as input
2. Has 64 output channels
3. Encodes the precise location by routing to channel N if bit N is set
4. Each channel sends a fixed public location (New York or London)
5. An "evil reader" downstream reassembles the bits

```
location (high precision)
    ↓
[evil router] ─→ 64 parallel paths, each carrying "New York" or "London"
    ↓
[to_city] × 64 ─→ 64 city names, all now "LowPrecision"
    ↓
[evil reader] ─→ reassembles original location, but labeled "Public"
```

**Why invariant 9 prevents this**: The routing decision (which of 64 paths) depends on the high-precision location. Therefore:
- Each output path is tainted by `HighPrecision` confidentiality
- The output *value* might be "New York", but the *fact that this path was taken* is high-confidentiality
- The evil reader receives 64 values all labeled `HighPrecision`
- Reassembly produces output still labeled `HighPrecision`
- Declassification is blocked

**Key insight**: Labels apply to both:
- **Data content**: The value itself (e.g., "New York")
- **Data flow**: Which path the data took to arrive (the routing decision)

This is why control-flow taint propagation matters: the decision to call a function, route to a path, or select an output must carry the label of the inputs that influenced that decision.

### Modification Attack (Boundary Probing)

A trusted `to_city()` component can be attacked by modifying inputs:

**Attack**: An adversary:
1. Takes high-precision location
2. Shifts it slightly in many directions
3. Calls `to_city()` on each shifted version
4. Observes when the city name changes (crossed a boundary)
5. Binary search narrows location to meters

**Why this is prevented**: The `to_city()` component requires input integrity:

```typescript
function to_city(location: Location): CityName {
  // Requires: location has TrustedMeasurement integrity
  // Without it, output has no LowPrecision endorsement
}
```

The shifted locations lack `TrustedMeasurement` integrity (they were computed by untrusted code), so `to_city()` either:
- Rejects the input, or
- Produces output without the `LowPrecision` endorsement

Either way, declassification is blocked.

---

## Open Problems

### Overlapping Declassifiers (Recombination Attack)

**Problem**: When multiple independent declassification paths exist for the same data, recombining their outputs can leak more information than either path alone.

**Example**: Two ways to declassify high-precision location:

1. **City rounding**: Maps location to nearest city center
2. **Grid snapping**: Maps location to a 10km grid cell

Individually, both provide reasonable privacy (low resolution). But combined:

```
Original location: (37.7749, -122.4194)  // San Francisco

City output: "San Francisco" (city center)
Grid output: "Grid cell G7" (covers part of SF and part of Oakland)

Recombination insight: The location must be in the intersection
of "San Francisco" and "Grid cell G7" — a much smaller area
than either declassification intended to reveal.
```

**Why this is hard**:
- Each declassification path is valid in isolation
- The combination leaks information neither intended to release
- Standard label propagation doesn't prevent this—both outputs are labeled identically

**Partial mitigations** (none fully satisfactory):
1. **Linkage tracking**: Track which declassifications derive from the same source, prevent recombination
2. **Semantic aliasing**: Treat outputs as "siblings" that can't be joined
3. **Differential privacy budgets**: Treat declassifications as spending from a privacy budget

**Status**: This remains an open problem. The current specification does not prevent this attack. Applications requiring protection against recombination attacks should:
- Use a single declassification path, or
- Implement application-specific linkage tracking, or
- Apply differential privacy techniques

This is related to composition attacks in differential privacy and requires further research to address systematically.
