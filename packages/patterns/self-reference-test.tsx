/// <cts-enable />
import { pattern, SELF, UI, Writable, Default } from "commontools";

interface Input {
  label: Default<string, "Untitled">;
  parent: Default<Output | null, null>;
  registry: Default<Writable<Output[]>, []>;
}
interface Output {
  label: string;
  parent: Output | null;
  children: Output[];
}

const Node = pattern<Input, Output>(
  ({ label, parent, registry, [SELF]: self }) => {
    const children = Writable.of<Output[]>([]);

    return {
      label,
      parent,
      children,
      [UI]: (
        <div>
          <button
            type="button"
            onClick={() =>
              children.push(Node({ label: "Child", parent: self, registry }))}
          >
            Add Child
          </button>
          <button
            type="button"
            onClick={() => registry.push(self)}
          >
            Add to Registry
          </button>
        </div>
      ),
    };
  },
);

export default Node;
