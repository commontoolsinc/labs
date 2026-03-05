/// <cts-enable />
import { pattern, UI } from "commontools";

interface Group {
  name: string;
  members: string[];
}

interface State {
  groups: Group[];
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <ul>
        {state.groups.flatMap((group) => group.members).map((member) => (
          <li>{member}</li>
        ))}
      </ul>
    ),
  };
});
