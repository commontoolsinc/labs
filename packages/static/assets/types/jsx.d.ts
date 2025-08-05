type Children = JSX.Element[] | JSX.Element | string | number | boolean | null | undefined;

type Child = {
  children?: Children;
};

type Cell<T> = {
  get(): T,
  set(value: T): void;
}

type Charm = any

type OutlinerNode = {
  body: string,
  children: OutlinerNode[],
  attachments: Charm[]
}

declare global {
  namespace JSX {
    interface Element {
      type: string;
      props: any;
      children?: Children;
    }

    interface IntrinsicElements {
      [elemName: string]: any;
      "ct-outliner": {
              $value: Cell<{ root: OutlinerNode }>,
              $mentionable?: Cell<Charm[]>
              'oncharm-link-click'?: any,
            } & Child;
    }
  }
}

export {};
