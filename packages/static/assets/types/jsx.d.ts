import type { OpaqueRef, Cell } from "commontools";

type Children = JSX.Element[] | JSX.Element | string | number | boolean | null | undefined;

type Child = {
  children?: Children;
};

type Elem = {
  id?: string
}

type HandlerEvent<T> = {
  detail: T,
}

// `Charm` is not a recipe type.
type Charm = any

type OutlinerNode = {
  body: string,
  children: OutlinerNode[],
  attachments: Charm[]
}

type CtListItem = {
  title: string,
  done?: boolean
}

declare global {
  namespace JSX {
    interface Element {
      type: "vnode";
      name: string;
      props: any;
      children: any;
    }

    interface IntrinsicElements {
      [elemName: string]: any;
      "ct-outliner": {
        "$value": OpaqueRef<Cell<{ root: OutlinerNode }>>,
        "$mentionable"?: OpaqueRef<Cell<Charm[]>>,
        "oncharm-link-click"?: OpaqueRef<HandlerEvent<{ charm: Cell<Charm> }>>,
      } & Child & Elem;
      "ct-list": {
        "$value": OpaqueRef<CtListItem[]>,
        /** setting this allows editing items inline */
        "editable"?: boolean,
        /** setting this hides the 'add item' form built into the list */
        "readonly"?: boolean,
        "title"?: string,
        "onct-remove-item"?: OpaqueRef<HandlerEvent<{ item: CtListItem }>>,
      } & Child & Elem;
      "ct-input": {
        "$value"?: OpaqueRef<string>,
        "customStyle"?: string, // bf: I think this is going to go away one day soon
        "type"?: string,
        "placeholder"?: string,
        "value"?: string,
        "disabled"?: boolean,
        "readonly"?: boolean,
        "error"?: boolean,
        "name"?: string,
        "required"?: boolean,
        "autofocus"?: boolean,
        "autocomplete"?: string,
        "min"?: string,
        "max"?: string,
        "step"?: string,
        "pattern"?: string,
        "maxlength"?: string,
        "minlength"?: string,
        "inputmode"?: string,
        "size"?: number,
        "multiple"?: boolean,
        "accept"?: string,
        "list"?: string,
        "spellcheck"?: boolean,
        "validationPattern"?: string,
        "showValidation"?: boolean,
        "timingStrategy"?: string,
        "timingDelay"?: number,
        "onct-change"?: any,
        "onct-focus"?: any,
        "onct-blur"?: any,
        "onct-keydown"?: any,
        "onct-submit"?: any,
        "onct-invalid"?: any,
      } & Child & Elem;
    }
  }
}

export {};
