import { derive, type Writable } from "commonfabric";

// FIXTURE: derive-unannotated-cell-input
// Verifies: the lowerDeriveCall typeRegistry override (lift/transformer.ts)
// preserves the asCell wrapper when a cell-like input flows into an
// UNANNOTATED callback param whose body uses no independent cell signal
// (no equals()/.equals()/.get()). The override pins the param's type to the
// input's widened type so schema injection emits asCell on the input schema.
//
// If the override is removed, the checker resolves the unannotated `state`
// param to the unwrapped value and the injected input schema loses
// `asCell: ["readonly"]` — the one line below changes.
//
// Note the param is intentionally UNANNOTATED and the body uses `===` (an
// identity comparison that carries no cell-detection signal). Annotating the
// param or calling .get()/equals() would re-establish cell-ness independently
// and mask the override.

const state = {} as (Writable<number> | undefined);
const same = derive(state, (state) => state === state);

export default {
  same,
};
