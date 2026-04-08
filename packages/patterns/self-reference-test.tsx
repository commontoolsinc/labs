import { Default, pattern, SELF, UI, Writable } from "commonfabric";

interface Input {
  label: Default<string, "Untitled">;
  parent: Default<Output | null, null>;
  registry: Writable<Default<Output[], []>>;
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
          <div>{parent ? <cf-cell-link $cell={parent} /> : "No parent"}</div>
          <div>
            Registry: {registry.map((node) => <cf-cell-link $cell={node} />)}
          </div>
          <div>
            Children: {children.map((node) => <cf-cell-link $cell={node} />)}
          </div>
        </div>
      ),
    };
  },
);

export default Node;
