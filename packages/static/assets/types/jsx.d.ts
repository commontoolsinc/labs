import type { OpaqueRef, Cell, Props, RenderNode, VNode } from "commontools";

type HTMLElementProps = {
  id?: string,
  style?: string;
}

type Children = {
  children?: RenderNode;
};

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
    // The output of a JSX renderer is a JSX.Element.
    // Our renderer (`@commontools/api#h`) outputs
    // `VNode`s. Redefine `JSX.Element` here as a `VNode`
    // for consistency.
    interface Element extends VNode {
      type: "vnode";
      name: string;
      props: Props;
      children?: RenderNode;
      $UI?: VNode;
    }

    interface IntrinsicElements {
      [elemName: string]: any;
      "ct-outliner": {
        "$value": OpaqueRef<Cell<{ root: OutlinerNode }>>,
        "$mentionable"?: OpaqueRef<Cell<Charm[]>>,
        "oncharm-link-click"?: OpaqueRef<HandlerEvent<{ charm: Cell<Charm> }>>,
      } & Children & HTMLElementProps;
      "ct-list": {
        "$value": OpaqueRef<CtListItem[]>,
        /** setting this allows editing items inline */
        "editable"?: boolean,
        /** setting this hides the 'add item' form built into the list */
        "readonly"?: boolean,
        "title"?: string,
        "onct-remove-item"?: OpaqueRef<HandlerEvent<{ item: CtListItem }>>,
      } & Children & HTMLElementProps;
      "ct-list-item": {
        "selected"?: boolean,
        "active"?: boolean,
        "disabled"?: boolean,
        /** Fired when the row is activated (click/Enter/Space) */
        "onct-activate"?: any,
      } & Children & HTMLElementProps;
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
      } & Children & HTMLElementProps;
      "ct-checkbox": {
        "$checked"?: OpaqueRef<boolean>,
        "checked"?: boolean,
        "disabled"?: boolean,
        "indeterminate"?: boolean,
        "name"?: string,
        "value"?: string,
        "onct-change"?: any,
      } & Children & HTMLElementProps;
      "ct-select": {
        "$value": OpaqueRef<any | any[]>,
        "items": { label: string, value: any }[],
        "multiple"?: boolean,
        "onct-change"?: OpaqueRef<HandlerEvent<{ items: { label: string, value: any }[], value: any | any[] }>>,
      } & Children & HTMLElementProps;
    }
  }
}

export {};
