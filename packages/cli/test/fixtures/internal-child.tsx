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
  [NAME]: computed(() => `internal child: ${label}`),
  label,
}));

type ChildPiece = ReturnType<typeof Child>;

export default pattern<Record<string, never>>(() => {
  const hidden = new Writable<ChildPiece[]>([]);

  const createChild = action(({ label }: { label: string }) => {
    hidden.push(Child({ label }));
  });

  return {
    [NAME]: "internal child factory",
    createChild,
    hiddenCount: computed(() => hidden.get().length),
  };
});
