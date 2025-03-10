import useWebComponent from "@/hooks/use-web-component.ts";
import React from "react";

export function WebComponent<P extends Record<string, any>>({
  as: Element,
  children,
  ...props
}: { as: string; children?: React.ReactNode } & P) {
  const ref = React.useRef<HTMLElement>(null);
  useWebComponent(ref, props);

  return React.createElement(Element, { ref, ...props }, children);
}
