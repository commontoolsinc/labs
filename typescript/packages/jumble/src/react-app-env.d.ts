/// <reference types="react-scripts" />

import { JSX } from "react";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elementName: string]:
        & React.DetailedHTMLProps<
          React.HTMLAttributes<HTMLElement>,
          HTMLElement
        >
        & {
          class?: string;
        };
    }
  }
}
