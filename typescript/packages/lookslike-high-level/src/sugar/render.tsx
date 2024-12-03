import { Behavior, h, Instruction, Reference, Service, Session, View } from "@commontools/common-system";

export function render<T extends { self: Reference }>(
  props: T,
  view: (props: T) => View<T>,
): Instruction {
  const vnode = view(props);
  return {
    Assert: [(props as any).self, "~/common/ui", vnode as any] as const,
  };
}

export const each = (items: Reference[], behaviour: Behavior | Service<any>) => items.map(a => <common-charm
  id={a.toString()}
  key={a.toString()}
  spell={() => behaviour}
  entity={() => a}
></common-charm>);

const empty = <div></div>

export function subview(viewRef: Reference, fallback: any = empty) {
  return viewRef == null ? fallback : Session.resolve(viewRef);
}
