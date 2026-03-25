/// <cts-enable />
import { Default, NAME, pattern, UI } from "commonfabric";

interface PatternState {
  count: Default<number, 0>;
  label: Default<string, "">;
}

// FIXTURE: builder-conditional
// Verifies: ternary in JSX is transformed to ifElse() with derive() for the condition
//   state.count > 0 ? <p>A</p> : <p>B</p> → __cfHelpers.ifElse(...schemas, derive(..., state.count > 0), <p>A</p>, <p>B</p>)
//   pattern<PatternState>                  → pattern(..., inputSchema, outputSchema)
//   state.label                            → state.key("label")
export default pattern<PatternState>((state) => {
  return {
    [NAME]: state.label,
    [UI]: (
      <section>
        {state.count > 0 ? <p>Positive</p> : <p>Non-positive</p>}
      </section>
    ),
  };
});
