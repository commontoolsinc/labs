// @ts-nocheck vendored
/**
Vendored from https://gist.github.com/giuseppelt/14d2bda071f728f5164baa76ecf60b01

Container component:
```
import { Slot } from "./components";

export function TestContainer({ children } ) {
  return (
    <div>
      <Slot name="header" required children={children} />
      <p>content</p>
      <Slot children={children} />
      <Slot name="footer" fallback={<p>Default Footer</p>} children={children} />
    </div>
  );
}
```

Using component:
```
import { TestContainer } from "./components";

export function ComplexComponent() {
   return (
      <TextContainer>
        <p slot="header">This will be the header</p>

        <p>Other body content</p>
        <p>Other body content</p>
        <p>Other body content</p>
      </TextContainer>
   );
}
```
*/
import { cloneElement, isValidElement, ReactElement, ReactNode } from "react";

declare global {
  namespace React {
    interface Attributes {
      slot?: string;
    }
  }
}

export type SlotProps = {
  name?: string;
  required?: boolean;
  fallback?: ReactElement;
  children?: ReactNode;
};

export function Slot(props: SlotProps) {
  const {
    name,
    children,
    required,
    fallback,
  } = props;

  // this is a default slot, that is, non-slotted children
  if (!name) {
    return getDefaultSlot(children);
  }

  // otherwise get it
  const Content = getSlot(children, name);
  if (Content) {
    // remove slot property
    return cloneElement(Content, { slot: undefined });
  }

  if (!Content && required) {
    throw new Error(`Slot(${name}) is required`);
  }

  return Content ?? fallback ?? null;
}

function getSlot(children: ReactNode, name: string): ReactElement | undefined {
  if (children) {
    if (Array.isArray(children)) {
      return children.find((x) =>
        isValidElement(x) && (x.props as any)?.slot === name
      );
    } else if (isValidElement(children) && children.props?.slot === name) {
      return children;
    }
  }
}

function getDefaultSlot(children: ReactNode) {
  if (children) {
    if (isValidElement(children)) {
      return children.props?.slot ? null : children;
    } else if (Array.isArray(children)) {
      return children.map((x) =>
        x && isValidElement(x) && (x.props as any)?.slot ? null : x
      );
    }
  }
  return children;
}
