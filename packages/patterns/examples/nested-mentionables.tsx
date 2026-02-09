/// <cts-enable />
import { computed, NAME, pattern, UI } from "commontools";

interface Node {
  label: string;
  children: Node[];
}

const TREE: Node = {
  label: "Root",
  children: [
    {
      label: "A",
      children: [
        { label: "A.1", children: [] },
        { label: "A.2", children: [{ label: "A.2.x", children: [] }] },
      ],
    },
    {
      label: "B",
      children: [{ label: "B.1", children: [] }],
    },
  ],
};

function toMentionable(node: Node): any {
  return {
    [NAME]: node.label,
    [UI]: <div>{node.label}</div>,
    mentionable: computed(() => node.children.map(toMentionable)),
  };
}

export default pattern<Record<string, never>>((_) => {
  const mentionables = TREE.children.map(toMentionable);

  return {
    [NAME]: "Nested Mentionables Test",
    [UI]: (
      <div>
        <p>This pattern exports a recursive mentionable tree:</p>
        <pre>{JSON.stringify(TREE, null, 2)}</pre>
      </div>
    ),
    mentionable: computed(() => mentionables),
  };
});
