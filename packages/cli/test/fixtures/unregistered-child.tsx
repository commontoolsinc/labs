import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  Writable,
} from "commonfabric";

interface ChildInput {
  label: string | Default<"kept child">;
}

export const Child = pattern<ChildInput>(({ label }) => ({
  [NAME]: computed(() => `child: ${label}`),
  label,
}));

type ChildPiece = ReturnType<typeof Child>;

interface ParentInput {
  children?: Writable<ChildPiece[] | Default<[]>>;
}

export default pattern<ParentInput>(({ children }) => {
  const createChild = action(({ label }: { label: string }) => {
    const child = Child({ label });
    children.push(child);
    return child;
  });

  return {
    [NAME]: "unregistered child factory",
    createChild,
    children,
  };
});
