type Child = {
  children: string[];
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
    interface IntrinsicElements {
      [elemName: string]: any;
      "ct-outliner": {
              $value: Cell<{ root: OutlinerNode }>,
              $mentionable: Cell<{"$NAME": string, "$UI": any }[]>
              'oncharm-link-click'?: (e: { detail: { item: Cell<Charm> } }) => void,
            } & Child;
    }
  }
}

export {};
