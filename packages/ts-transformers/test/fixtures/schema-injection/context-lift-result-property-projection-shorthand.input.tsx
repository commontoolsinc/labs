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

// FIXTURE: context-lift-result-property-projection-shorthand
// Verifies: shorthand object returns preserve the projected derive() result type
//   return { difference } → result schema difference: number
export default pattern<{ primary: Cell<number>; secondary: Cell<number> }>(
  ({ primary, secondary }) => {
    const summary = liftSummary({ primary, secondary });
    const difference = derive(summary, (snapshot) => snapshot.difference);

    return { difference };
  },
);
