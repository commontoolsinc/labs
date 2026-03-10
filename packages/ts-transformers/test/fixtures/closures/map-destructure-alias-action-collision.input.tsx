/// <cts-enable />
import { pattern, UI } from "commontools";

interface Spot {
  spotNumber: string;
}

interface State {
  spots: Spot[];
}

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
