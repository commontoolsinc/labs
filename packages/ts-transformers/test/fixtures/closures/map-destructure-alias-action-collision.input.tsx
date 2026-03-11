/// <cts-enable />
import { pattern, UI } from "commontools";

interface Spot {
  spotNumber: string;
}

interface State {
  spots: Spot[];
}

// FIXTURE: map-destructure-alias-action-collision
// Verifies: destructured alias inside map callback body is preserved as-is in the output
//   const { spotNumber: sn } = spot → kept as destructure from the element binding
//   .map(fn) → .mapWithPattern(pattern(...), {})
// Context: Alias is in the callback body (not the parameter), so no lowering to key() is needed
export default pattern<State>((state) => {
  return {
    [UI]: (
      <ul>
        {state.spots.map((spot) => {
          const { spotNumber: sn } = spot;
          return <li>{sn}</li>;
        })}
      </ul>
    ),
  };
});
