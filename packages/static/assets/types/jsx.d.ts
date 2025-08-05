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

type ListItem = {
  title: string,
  done?: boolean
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
      "ct-list": {
        $value: Cell<ListItem[]>,
        /** setting this allows editing items inline */
        editable?: boolean,
        /** setting this hides the 'add item' form built into the list */
        readonly?: boolean,
        title?: string,
        'onct-remove-item'?: any,
      } & Child;
    }
  }
}

export {};
