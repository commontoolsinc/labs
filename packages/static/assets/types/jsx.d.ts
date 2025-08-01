type Child = {
  children: string[];
};

type Cell<T> = {
  get(): T,
  set(value: T): void;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: any;
      "ct-list": {
              value?: { title: string }[],
              $value?: Cell<{ title: string }[]>,
              editable?: boolean,
              title?: string,
              onct-remove-item?: (e: { detail: { item: Cell<{ title: string }> } }) => void,
            } & Child;
    }
  }
}

export {};