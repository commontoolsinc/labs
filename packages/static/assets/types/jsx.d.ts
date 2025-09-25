import type { OpaqueRef, Cell, Props, RenderNode, VNode } from "commontools";

// Minimal theme typing for ct-theme
type CTColorToken = string | {
  light: string;
  dark: string;
};

interface CTThemeColors {
  primary: CTColorToken;
  primaryForeground: CTColorToken;
  secondary: CTColorToken;
  secondaryForeground: CTColorToken;
  background: CTColorToken;
  surface: CTColorToken;
  surfaceHover: CTColorToken;
  text: CTColorToken;
  textMuted: CTColorToken;
  border: CTColorToken;
  borderMuted: CTColorToken;
  success: CTColorToken;
  successForeground: CTColorToken;
  error: CTColorToken;
  errorForeground: CTColorToken;
  warning: CTColorToken;
  warningForeground: CTColorToken;
  accent: CTColorToken;
  accentForeground: CTColorToken;
}

interface CTThemeDef {
  fontFamily: string;
  monoFontFamily: string;
  borderRadius: string;
  density: "compact" | "comfortable" | "spacious";
  colorScheme: "light" | "dark" | "auto";
  animationSpeed: "none" | "slow" | "normal" | "fast";
  colors: CTThemeColors;
}

type CTThemeInput = Partial<CTThemeDef> & Record<string, unknown>;

type HTMLElementProps = {
  id?: string,
  style?: string;
  slot?: string;
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
      "ct-heading": {
        "level"?: number,
        "no-margin"?: boolean,
      } & Children & HTMLElementProps;
      "ct-collapsible": {
        "open"?: boolean,
        "disabled"?: boolean,
        "onct-toggle"?: any,
      } & Children & HTMLElementProps;
      "ct-theme": {
        theme?: CTThemeInput,
      } & Children & HTMLElementProps;
      "ct-code-editor": {
        "$value"?: OpaqueRef<string>,
        "value"?: string,
        "language"?: string,
        "disabled"?: boolean,
        "readonly"?: boolean,
        "placeholder"?: string,
        "timingStrategy"?: string,
        "timingDelay"?: number,
        "$mentionable"?: OpaqueRef<Charm[]> | OpaqueRef<Cell<Charm[]>>,
        "mentionable"?: Charm[],
        "$mentioned"?: OpaqueRef<Charm[]> | OpaqueRef<Cell<Charm[]>>,
        "wordWrap"?: boolean,
        "lineNumbers"?: boolean,
        "maxLineWidth"?: number,
        "tabSize"?: number,
        "tabIndent"?: boolean,
        "theme"?: "light" | "dark",
        "onct-change"?: any,
        "onct-focus"?: any,
        "onct-blur"?: any,
        "onbacklink-click"?: any,
        "onbacklink-create"?: any,
      } & Children & HTMLElementProps;
    }
  }
}

export {};
