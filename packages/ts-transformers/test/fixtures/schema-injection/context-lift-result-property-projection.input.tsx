/// <cts-enable />
import { Cell, derive, lift, pattern, Writable } from "commonfabric";

const liftSummary = lift<
  { primary: Writable<number>; secondary: Writable<number> }
>(({ primary, secondary }) => {
  const primaryValue = primary.get();
  const secondaryValue = secondary.get();
  return {
    primary: primaryValue,
    secondary: secondaryValue,
    difference: primaryValue - secondaryValue,
  };
});

// FIXTURE: context-lift-result-property-projection
// Verifies: derive() preserves projected property schemas when the input comes
// from a typed lift() result rather than falling back to unknown
//   derive(summary, (snapshot) => snapshot.difference) → derive({ difference: number }, number, ...)
export default pattern<{ primary: Cell<number>; secondary: Cell<number> }>(
  ({ primary, secondary }) => {
    const summary = liftSummary({ primary, secondary });
    const difference = derive(summary, (snapshot) => snapshot.difference);

    return {
      summary,
      difference,
    };
  },
);
