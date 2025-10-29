import type {
  Cell,
  Opaque,
  OpaqueRef,
  OpaqueRefMethods,
  Props,
  RenderNode,
  Stream,
  VNode,
} from "commontools";

// DOM-ish types for the CT runtime.
// The DOM is not directly available within the runtime, but the JSX
// produced must be typed. This defines DOM types like React or Preact,
// with a subset of supported features, and cannot rely on globals
// existing like `HTMLElement` from TypeScript's `dom` lib.
declare namespace CTDOM {
  /**
   * Used to represent DOM API's where users can either pass
   * true or false as a boolean or as its equivalent strings.
   */
  type Booleanish = boolean | "true" | "false";

  /**
   * @see {@link https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/crossorigin MDN}
   */
  type CrossOrigin = "anonymous" | "use-credentials" | "" | undefined;

  /**
   * Stub out `HTMLElement` in a raw CT environment.
   * Extend other subclasses for usage in types.
   * TBD how we want to interact with DOM elements within a sandbox.
   * Maybe some of these elements should inherit from each other.
   */
  export interface HTMLElement {}
  export interface HTMLAnchorElement extends HTMLElement {}
  export interface HTMLAreaElement extends HTMLElement {}
  export interface HTMLAudioElement extends HTMLElement {}
  export interface HTMLBaseElement extends HTMLElement {}
  export interface HTMLBodyElement extends HTMLElement {}
  export interface HTMLBRElement extends HTMLElement {}
  export interface HTMLButtonElement extends HTMLElement {}
  export interface HTMLCanvasElement extends HTMLElement {}
  export interface HTMLDataElement extends HTMLElement {}
  export interface HTMLDataListElement extends HTMLElement {}
  export interface HTMLDetailsElement extends HTMLElement {}
  export interface HTMLDialogElement extends HTMLElement {}
  export interface HTMLDivElement extends HTMLElement {}
  export interface HTMLDListElement extends HTMLElement {}
  export interface HTMLEmbedElement extends HTMLElement {}
  export interface HTMLFieldSetElement extends HTMLElement {}
  export interface HTMLFormElement extends HTMLElement {}
  export interface HTMLHeadingElement extends HTMLElement {}
  export interface HTMLHeadElement extends HTMLElement {}
  export interface HTMLHRElement extends HTMLElement {}
  export interface HTMLHtmlElement extends HTMLElement {}
  export interface HTMLIFrameElement extends HTMLElement {}
  export interface HTMLImageElement extends HTMLElement {}
  export interface HTMLInputElement extends HTMLElement {}
  export interface HTMLLabelElement extends HTMLElement {}
  export interface HTMLLegendElement extends HTMLElement {}
  export interface HTMLLIElement extends HTMLElement {}
  export interface HTMLLinkElement extends HTMLElement {}
  export interface HTMLMapElement extends HTMLElement {}
  export interface HTMLMetaElement extends HTMLElement {}
  export interface HTMLMeterElement extends HTMLElement {}
  export interface HTMLModElement extends HTMLElement {}
  export interface HTMLObjectElement extends HTMLElement {}
  export interface HTMLOListElement extends HTMLElement {}
  export interface HTMLOptGroupElement extends HTMLElement {}
  export interface HTMLOptionElement extends HTMLElement {}
  export interface HTMLOutputElement extends HTMLElement {}
  export interface HTMLParagraphElement extends HTMLElement {}
  export interface HTMLParamElement extends HTMLElement {}
  export interface HTMLPreElement extends HTMLElement {}
  export interface HTMLProgressElement extends HTMLElement {}
  export interface HTMLQuoteElement extends HTMLElement {}
  export interface HTMLSlotElement extends HTMLElement {}
  export interface HTMLScriptElement extends HTMLElement {}
  export interface HTMLSelectElement extends HTMLElement {}
  export interface HTMLSourceElement extends HTMLElement {}
  export interface HTMLSpanElement extends HTMLElement {}
  export interface HTMLStyleElement extends HTMLElement {}
  export interface HTMLTableColElement extends HTMLElement {}
  export interface HTMLTableDataCellElement extends HTMLElement {}
  export interface HTMLTableElement extends HTMLElement {}
  export interface HTMLTableHeaderCellElement extends HTMLElement {}
  export interface HTMLTableRowElement extends HTMLElement {}
  export interface HTMLTableSectionElement extends HTMLElement {}
  export interface HTMLTemplateElement extends HTMLElement {}
  export interface HTMLTextAreaElement extends HTMLElement {}
  export interface HTMLTimeElement extends HTMLElement {}
  export interface HTMLTitleElement extends HTMLElement {}
  export interface HTMLTrackElement extends HTMLElement {}
  export interface HTMLUListElement extends HTMLElement {}
  export interface HTMLVideoElement extends HTMLElement {}
  export interface HTMLWebViewElement extends HTMLElement {}

  /**
   * Represents the built-in attributes available to class components.
   */
  interface ClassAttributes<T> {}

  // TBD
  interface CSSProperties {}

  export interface HTMLProps<T>
    extends AllHTMLAttributes<T>, ClassAttributes<T> {
  }

  export type DetailedHTMLProps<E extends HTMLAttributes<T>, T> =
    & ClassAttributes<T>
    & E;

  // All the WAI-ARIA 1.1 attributes from https://www.w3.org/TR/wai-aria-1.1/
  interface AriaAttributes {
    /** Identifies the currently active element when DOM focus is on a composite widget, textbox, group, or application. */
    "aria-activedescendant"?: string | undefined;
    /** Indicates whether assistive technologies will present all, or only parts of, the changed region based on the change notifications defined by the aria-relevant attribute. */
    "aria-atomic"?: Booleanish | undefined;
    /**
     * Indicates whether inputting text could trigger display of one or more predictions of the user's intended value for an input and specifies how predictions would be
     * presented if they are made.
     */
    "aria-autocomplete"?: "none" | "inline" | "list" | "both" | undefined;
    /** Indicates an element is being modified and that assistive technologies MAY want to wait until the modifications are complete before exposing them to the user. */
    /**
     * Defines a string value that labels the current element, which is intended to be converted into Braille.
     * @see aria-label.
     */
    "aria-braillelabel"?: string | undefined;
    /**
     * Defines a human-readable, author-localized abbreviated description for the role of an element, which is intended to be converted into Braille.
     * @see aria-roledescription.
     */
    "aria-brailleroledescription"?: string | undefined;
    "aria-busy"?: Booleanish | undefined;
    /**
     * Indicates the current "checked" state of checkboxes, radio buttons, and other widgets.
     * @see aria-pressed @see aria-selected.
     */
    "aria-checked"?: boolean | "false" | "mixed" | "true" | undefined;
    /**
     * Defines the total number of columns in a table, grid, or treegrid.
     * @see aria-colindex.
     */
    "aria-colcount"?: number | undefined;
    /**
     * Defines an element's column index or position with respect to the total number of columns within a table, grid, or treegrid.
     * @see aria-colcount @see aria-colspan.
     */
    "aria-colindex"?: number | undefined;
    /**
     * Defines a human readable text alternative of aria-colindex.
     * @see aria-rowindextext.
     */
    "aria-colindextext"?: string | undefined;
    /**
     * Defines the number of columns spanned by a cell or gridcell within a table, grid, or treegrid.
     * @see aria-colindex @see aria-rowspan.
     */
    "aria-colspan"?: number | undefined;
    /**
     * Identifies the element (or elements) whose contents or presence are controlled by the current element.
     * @see aria-owns.
     */
    "aria-controls"?: string | undefined;
    /** Indicates the element that represents the current item within a container or set of related elements. */
    "aria-current"?:
      | boolean
      | "false"
      | "true"
      | "page"
      | "step"
      | "location"
      | "date"
      | "time"
      | undefined;
    /**
     * Identifies the element (or elements) that describes the object.
     * @see aria-labelledby
     */
    "aria-describedby"?: string | undefined;
    /**
     * Defines a string value that describes or annotates the current element.
     * @see related aria-describedby.
     */
    "aria-description"?: string | undefined;
    /**
     * Identifies the element that provides a detailed, extended description for the object.
     * @see aria-describedby.
     */
    "aria-details"?: string | undefined;
    /**
     * Indicates that the element is perceivable but disabled, so it is not editable or otherwise operable.
     * @see aria-hidden @see aria-readonly.
     */
    "aria-disabled"?: Booleanish | undefined;
    /**
     * Indicates what functions can be performed when a dragged object is released on the drop target.
     * @deprecated in ARIA 1.1
     */
    "aria-dropeffect"?:
      | "none"
      | "copy"
      | "execute"
      | "link"
      | "move"
      | "popup"
      | undefined;
    /**
     * Identifies the element that provides an error message for the object.
     * @see aria-invalid @see aria-describedby.
     */
    "aria-errormessage"?: string | undefined;
    /** Indicates whether the element, or another grouping element it controls, is currently expanded or collapsed. */
    "aria-expanded"?: Booleanish | undefined;
    /**
     * Identifies the next element (or elements) in an alternate reading order of content which, at the user's discretion,
     * allows assistive technology to override the general default of reading in document source order.
     */
    "aria-flowto"?: string | undefined;
    /**
     * Indicates an element's "grabbed" state in a drag-and-drop operation.
     * @deprecated in ARIA 1.1
     */
    "aria-grabbed"?: Booleanish | undefined;
    /** Indicates the availability and type of interactive popup element, such as menu or dialog, that can be triggered by an element. */
    "aria-haspopup"?:
      | boolean
      | "false"
      | "true"
      | "menu"
      | "listbox"
      | "tree"
      | "grid"
      | "dialog"
      | undefined;
    /**
     * Indicates whether the element is exposed to an accessibility API.
     * @see aria-disabled.
     */
    "aria-hidden"?: Booleanish | undefined;
    /**
     * Indicates the entered value does not conform to the format expected by the application.
     * @see aria-errormessage.
     */
    "aria-invalid"?:
      | boolean
      | "false"
      | "true"
      | "grammar"
      | "spelling"
      | undefined;
    /** Indicates keyboard shortcuts that an author has implemented to activate or give focus to an element. */
    "aria-keyshortcuts"?: string | undefined;
    /**
     * Defines a string value that labels the current element.
     * @see aria-labelledby.
     */
    "aria-label"?: string | undefined;
    /**
     * Identifies the element (or elements) that labels the current element.
     * @see aria-describedby.
     */
    "aria-labelledby"?: string | undefined;
    /** Defines the hierarchical level of an element within a structure. */
    "aria-level"?: number | undefined;
    /** Indicates that an element will be updated, and describes the types of updates the user agents, assistive technologies, and user can expect from the live region. */
    "aria-live"?: "off" | "assertive" | "polite" | undefined;
    /** Indicates whether an element is modal when displayed. */
    "aria-modal"?: Booleanish | undefined;
    /** Indicates whether a text box accepts multiple lines of input or only a single line. */
    "aria-multiline"?: Booleanish | undefined;
    /** Indicates that the user may select more than one item from the current selectable descendants. */
    "aria-multiselectable"?: Booleanish | undefined;
    /** Indicates whether the element's orientation is horizontal, vertical, or unknown/ambiguous. */
    "aria-orientation"?: "horizontal" | "vertical" | undefined;
    /**
     * Identifies an element (or elements) in order to define a visual, functional, or contextual parent/child relationship
     * between DOM elements where the DOM hierarchy cannot be used to represent the relationship.
     * @see aria-controls.
     */
    "aria-owns"?: string | undefined;
    /**
     * Defines a short hint (a word or short phrase) intended to aid the user with data entry when the control has no value.
     * A hint could be a sample value or a brief description of the expected format.
     */
    "aria-placeholder"?: string | undefined;
    /**
     * Defines an element's number or position in the current set of listitems or treeitems. Not required if all elements in the set are present in the DOM.
     * @see aria-setsize.
     */
    "aria-posinset"?: number | undefined;
    /**
     * Indicates the current "pressed" state of toggle buttons.
     * @see aria-checked @see aria-selected.
     */
    "aria-pressed"?: boolean | "false" | "mixed" | "true" | undefined;
    /**
     * Indicates that the element is not editable, but is otherwise operable.
     * @see aria-disabled.
     */
    "aria-readonly"?: Booleanish | undefined;
    /**
     * Indicates what notifications the user agent will trigger when the accessibility tree within a live region is modified.
     * @see aria-atomic.
     */
    "aria-relevant"?:
      | "additions"
      | "additions removals"
      | "additions text"
      | "all"
      | "removals"
      | "removals additions"
      | "removals text"
      | "text"
      | "text additions"
      | "text removals"
      | undefined;
    /** Indicates that user input is required on the element before a form may be submitted. */
    "aria-required"?: Booleanish | undefined;
    /** Defines a human-readable, author-localized description for the role of an element. */
    "aria-roledescription"?: string | undefined;
    /**
     * Defines the total number of rows in a table, grid, or treegrid.
     * @see aria-rowindex.
     */
    "aria-rowcount"?: number | undefined;
    /**
     * Defines an element's row index or position with respect to the total number of rows within a table, grid, or treegrid.
     * @see aria-rowcount @see aria-rowspan.
     */
    "aria-rowindex"?: number | undefined;
    /**
     * Defines a human readable text alternative of aria-rowindex.
     * @see aria-colindextext.
     */
    "aria-rowindextext"?: string | undefined;
    /**
     * Defines the number of rows spanned by a cell or gridcell within a table, grid, or treegrid.
     * @see aria-rowindex @see aria-colspan.
     */
    "aria-rowspan"?: number | undefined;
    /**
     * Indicates the current "selected" state of various widgets.
     * @see aria-checked @see aria-pressed.
     */
    "aria-selected"?: Booleanish | undefined;
    /**
     * Defines the number of items in the current set of listitems or treeitems. Not required if all elements in the set are present in the DOM.
     * @see aria-posinset.
     */
    "aria-setsize"?: number | undefined;
    /** Indicates if items in a table or grid are sorted in ascending or descending order. */
    "aria-sort"?: "none" | "ascending" | "descending" | "other" | undefined;
    /** Defines the maximum allowed value for a range widget. */
    "aria-valuemax"?: number | undefined;
    /** Defines the minimum allowed value for a range widget. */
    "aria-valuemin"?: number | undefined;
    /**
     * Defines the current value for a range widget.
     * @see aria-valuetext.
     */
    "aria-valuenow"?: number | undefined;
    /** Defines the human readable text alternative of aria-valuenow for a range widget. */
    "aria-valuetext"?: string | undefined;
  }

  // All the WAI-ARIA 1.1 role attribute values from https://www.w3.org/TR/wai-aria-1.1/#role_definitions
  type AriaRole =
    | "alert"
    | "alertdialog"
    | "application"
    | "article"
    | "banner"
    | "button"
    | "cell"
    | "checkbox"
    | "columnheader"
    | "combobox"
    | "complementary"
    | "contentinfo"
    | "definition"
    | "dialog"
    | "directory"
    | "document"
    | "feed"
    | "figure"
    | "form"
    | "grid"
    | "gridcell"
    | "group"
    | "heading"
    | "img"
    | "link"
    | "list"
    | "listbox"
    | "listitem"
    | "log"
    | "main"
    | "marquee"
    | "math"
    | "menu"
    | "menubar"
    | "menuitem"
    | "menuitemcheckbox"
    | "menuitemradio"
    | "navigation"
    | "none"
    | "note"
    | "option"
    | "presentation"
    | "progressbar"
    | "radio"
    | "radiogroup"
    | "region"
    | "row"
    | "rowgroup"
    | "rowheader"
    | "scrollbar"
    | "search"
    | "searchbox"
    | "separator"
    | "slider"
    | "spinbutton"
    | "status"
    | "switch"
    | "tab"
    | "table"
    | "tablist"
    | "tabpanel"
    | "term"
    | "textbox"
    | "timer"
    | "toolbar"
    | "tooltip"
    | "tree"
    | "treegrid"
    | "treeitem"
    | (string & {});

  export interface HTMLAttributes<T> extends AriaAttributes, DOMAttributes<T> {
    // CT extensions
    "onClick"?: CellLike<HandlerEvent<unknown>>;
    "children"?: RenderNode | undefined;
    // Allow React-isms
    "key"?: number;

    // Standard HTML Attributes
    accessKey?: string | undefined;
    autoCapitalize?:
      | "off"
      | "none"
      | "on"
      | "sentences"
      | "words"
      | "characters"
      | undefined
      | (string & {});
    autoFocus?: boolean | undefined;
    className?: string | undefined;
    contentEditable?: Booleanish | "inherit" | "plaintext-only" | undefined;
    contextMenu?: string | undefined;
    dir?: string | undefined;
    draggable?: Booleanish | undefined;
    enterKeyHint?:
      | "enter"
      | "done"
      | "go"
      | "next"
      | "previous"
      | "search"
      | "send"
      | undefined;
    hidden?: boolean | undefined;
    id?: string | undefined;
    lang?: string | undefined;
    nonce?: string | undefined;
    slot?: string | undefined;
    spellCheck?: Booleanish | undefined;
    style?: CSSProperties | undefined;
    tabIndex?: number | undefined;
    title?: string | undefined;
    translate?: "yes" | "no" | undefined;

    // Unknown
    radioGroup?: string | undefined; // <command>, <menuitem>

    // WAI-ARIA
    role?: AriaRole | undefined;

    // RDFa Attributes
    about?: string | undefined;
    content?: string | undefined;
    datatype?: string | undefined;
    inlist?: any;
    prefix?: string | undefined;
    property?: string | undefined;
    rel?: string | undefined;
    resource?: string | undefined;
    rev?: string | undefined;
    typeof?: string | undefined;
    vocab?: string | undefined;

    // Non-standard Attributes
    autoCorrect?: string | undefined;
    autoSave?: string | undefined;
    color?: string | undefined;
    itemProp?: string | undefined;
    itemScope?: boolean | undefined;
    itemType?: string | undefined;
    itemID?: string | undefined;
    itemRef?: string | undefined;
    results?: number | undefined;
    security?: string | undefined;
    unselectable?: "on" | "off" | undefined;

    // Popover API
    popover?: "" | "auto" | "manual" | "hint" | undefined;
    popoverTargetAction?: "toggle" | "show" | "hide" | undefined;
    popoverTarget?: string | undefined;

    // Living Standard
    /**
     * @see https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/inert
     */
    inert?: boolean | undefined;
    /**
     * Hints at the type of data that might be entered by the user while editing the element or its contents
     * @see {@link https://html.spec.whatwg.org/multipage/interaction.html#input-modalities:-the-inputmode-attribute}
     */
    inputMode?:
      | "none"
      | "text"
      | "tel"
      | "url"
      | "email"
      | "numeric"
      | "decimal"
      | "search"
      | undefined;
    /**
     * Specify that a standard HTML element should behave like a defined custom built-in element
     * @see {@link https://html.spec.whatwg.org/multipage/custom-elements.html#attr-is}
     */
    is?: string | undefined;
    /**
     * @see {@link https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/exportparts}
     */
    exportparts?: string | undefined;
    /**
     * @see {@link https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/part}
     */
    part?: string | undefined;
  }

  interface AllHTMLAttributes<T> extends HTMLAttributes<T> {
    // Standard HTML Attributes
    accept?: string | undefined;
    acceptCharset?: string | undefined;
    action?:
      | string
      | undefined;
    allowFullScreen?: boolean | undefined;
    allowTransparency?: boolean | undefined;
    alt?: string | undefined;
    as?: string | undefined;
    async?: boolean | undefined;
    autoComplete?: string | undefined;
    autoPlay?: boolean | undefined;
    capture?: boolean | "user" | "environment" | undefined;
    cellPadding?: number | string | undefined;
    cellSpacing?: number | string | undefined;
    charSet?: string | undefined;
    challenge?: string | undefined;
    checked?: boolean | undefined;
    cite?: string | undefined;
    classID?: string | undefined;
    cols?: number | undefined;
    colSpan?: number | undefined;
    controls?: boolean | undefined;
    coords?: string | undefined;
    crossOrigin?: CrossOrigin;
    data?: string | undefined;
    dateTime?: string | undefined;
    default?: boolean | undefined;
    defer?: boolean | undefined;
    disabled?: boolean | undefined;
    download?: any;
    encType?: string | undefined;
    form?: string | undefined;
    formAction?:
      | string
      | undefined;
    formEncType?: string | undefined;
    formMethod?: string | undefined;
    formNoValidate?: boolean | undefined;
    formTarget?: string | undefined;
    frameBorder?: number | string | undefined;
    headers?: string | undefined;
    height?: number | string | undefined;
    high?: number | undefined;
    href?: string | undefined;
    hrefLang?: string | undefined;
    htmlFor?: string | undefined;
    httpEquiv?: string | undefined;
    integrity?: string | undefined;
    keyParams?: string | undefined;
    keyType?: string | undefined;
    kind?: string | undefined;
    label?: string | undefined;
    list?: string | undefined;
    loop?: boolean | undefined;
    low?: number | undefined;
    manifest?: string | undefined;
    marginHeight?: number | undefined;
    marginWidth?: number | undefined;
    max?: number | string | undefined;
    maxLength?: number | undefined;
    media?: string | undefined;
    mediaGroup?: string | undefined;
    method?: string | undefined;
    min?: number | string | undefined;
    minLength?: number | undefined;
    multiple?: boolean | undefined;
    muted?: boolean | undefined;
    name?: string | undefined;
    noValidate?: boolean | undefined;
    open?: boolean | undefined;
    optimum?: number | undefined;
    pattern?: string | undefined;
    placeholder?: string | undefined;
    playsInline?: boolean | undefined;
    poster?: string | undefined;
    preload?: string | undefined;
    readOnly?: boolean | undefined;
    required?: boolean | undefined;
    reversed?: boolean | undefined;
    rows?: number | undefined;
    rowSpan?: number | undefined;
    sandbox?: string | undefined;
    scope?: string | undefined;
    scoped?: boolean | undefined;
    scrolling?: string | undefined;
    seamless?: boolean | undefined;
    selected?: boolean | undefined;
    shape?: string | undefined;
    size?: number | undefined;
    sizes?: string | undefined;
    span?: number | undefined;
    src?: string | undefined;
    srcDoc?: string | undefined;
    srcLang?: string | undefined;
    srcSet?: string | undefined;
    start?: number | undefined;
    step?: number | string | undefined;
    summary?: string | undefined;
    target?: string | undefined;
    type?: string | undefined;
    useMap?: string | undefined;
    value?: string | readonly string[] | number | undefined;
    width?: number | string | undefined;
    wmode?: string | undefined;
    wrap?: string | undefined;
  }

  type HTMLAttributeReferrerPolicy =
    | ""
    | "no-referrer"
    | "no-referrer-when-downgrade"
    | "origin"
    | "origin-when-cross-origin"
    | "same-origin"
    | "strict-origin"
    | "strict-origin-when-cross-origin"
    | "unsafe-url";

  type HTMLAttributeAnchorTarget =
    | "_self"
    | "_blank"
    | "_parent"
    | "_top"
    | (string & {});

  interface AnchorHTMLAttributes<T> extends HTMLAttributes<T> {
    download?: any;
    href?: string | undefined;
    hrefLang?: string | undefined;
    media?: string | undefined;
    ping?: string | undefined;
    target?: HTMLAttributeAnchorTarget | undefined;
    type?: string | undefined;
    referrerPolicy?: HTMLAttributeReferrerPolicy | undefined;
  }

  interface AudioHTMLAttributes<T> extends MediaHTMLAttributes<T> {}

  interface AreaHTMLAttributes<T> extends HTMLAttributes<T> {
    alt?: string | undefined;
    coords?: string | undefined;
    download?: any;
    href?: string | undefined;
    hrefLang?: string | undefined;
    media?: string | undefined;
    referrerPolicy?: HTMLAttributeReferrerPolicy | undefined;
    shape?: string | undefined;
    target?: string | undefined;
  }

  interface BaseHTMLAttributes<T> extends HTMLAttributes<T> {
    href?: string | undefined;
    target?: string | undefined;
  }

  interface BlockquoteHTMLAttributes<T> extends HTMLAttributes<T> {
    cite?: string | undefined;
  }

  interface ButtonHTMLAttributes<T> extends HTMLAttributes<T> {
    disabled?: boolean | undefined;
    form?: string | undefined;
    formAction?:
      | string
      | undefined;
    formEncType?: string | undefined;
    formMethod?: string | undefined;
    formNoValidate?: boolean | undefined;
    formTarget?: string | undefined;
    name?: string | undefined;
    type?: "submit" | "reset" | "button" | undefined;
    value?: string | readonly string[] | number | undefined;
  }

  interface CanvasHTMLAttributes<T> extends HTMLAttributes<T> {
    height?: number | string | undefined;
    width?: number | string | undefined;
  }

  interface ColHTMLAttributes<T> extends HTMLAttributes<T> {
    span?: number | undefined;
    width?: number | string | undefined;
  }

  interface ColgroupHTMLAttributes<T> extends HTMLAttributes<T> {
    span?: number | undefined;
  }

  interface DataHTMLAttributes<T> extends HTMLAttributes<T> {
    value?: string | readonly string[] | number | undefined;
  }

  interface DetailsHTMLAttributes<T> extends HTMLAttributes<T> {
    open?: boolean | undefined;
    name?: string | undefined;
  }

  interface DelHTMLAttributes<T> extends HTMLAttributes<T> {
    cite?: string | undefined;
    dateTime?: string | undefined;
  }

  interface DialogHTMLAttributes<T> extends HTMLAttributes<T> {
    closedby?: "any" | "closerequest" | "none" | undefined;
    // @TODO(events)
    //onCancel?: ReactEventHandler<T> | undefined;
    // @TODO(events)
    //onClose?: ReactEventHandler<T> | undefined;
    open?: boolean | undefined;
  }

  interface EmbedHTMLAttributes<T> extends HTMLAttributes<T> {
    height?: number | string | undefined;
    src?: string | undefined;
    type?: string | undefined;
    width?: number | string | undefined;
  }

  interface FieldsetHTMLAttributes<T> extends HTMLAttributes<T> {
    disabled?: boolean | undefined;
    form?: string | undefined;
    name?: string | undefined;
  }

  interface FormHTMLAttributes<T> extends HTMLAttributes<T> {
    acceptCharset?: string | undefined;
    action?:
      | string
      | undefined;
    autoComplete?: string | undefined;
    encType?: string | undefined;
    method?: string | undefined;
    name?: string | undefined;
    noValidate?: boolean | undefined;
    target?: string | undefined;
  }

  interface HtmlHTMLAttributes<T> extends HTMLAttributes<T> {
    manifest?: string | undefined;
  }

  interface IframeHTMLAttributes<T> extends HTMLAttributes<T> {
    allow?: string | undefined;
    allowFullScreen?: boolean | undefined;
    allowTransparency?: boolean | undefined;
    /** @deprecated */
    frameBorder?: number | string | undefined;
    height?: number | string | undefined;
    loading?: "eager" | "lazy" | undefined;
    /** @deprecated */
    marginHeight?: number | undefined;
    /** @deprecated */
    marginWidth?: number | undefined;
    name?: string | undefined;
    referrerPolicy?: HTMLAttributeReferrerPolicy | undefined;
    sandbox?: string | undefined;
    /** @deprecated */
    scrolling?: string | undefined;
    seamless?: boolean | undefined;
    src?: string | undefined;
    srcDoc?: string | undefined;
    width?: number | string | undefined;
  }

  interface ImgHTMLAttributes<T> extends HTMLAttributes<T> {
    alt?: string | undefined;
    crossOrigin?: CrossOrigin;
    decoding?: "async" | "auto" | "sync" | undefined;
    fetchPriority?: "high" | "low" | "auto";
    height?: number | string | undefined;
    loading?: "eager" | "lazy" | undefined;
    referrerPolicy?: HTMLAttributeReferrerPolicy | undefined;
    sizes?: string | undefined;
    src?:
      | string
      | undefined;
    srcSet?: string | undefined;
    useMap?: string | undefined;
    width?: number | string | undefined;
  }

  interface InsHTMLAttributes<T> extends HTMLAttributes<T> {
    cite?: string | undefined;
    dateTime?: string | undefined;
  }

  type HTMLInputTypeAttribute =
    | "button"
    | "checkbox"
    | "color"
    | "date"
    | "datetime-local"
    | "email"
    | "file"
    | "hidden"
    | "image"
    | "month"
    | "number"
    | "password"
    | "radio"
    | "range"
    | "reset"
    | "search"
    | "submit"
    | "tel"
    | "text"
    | "time"
    | "url"
    | "week"
    | (string & {});

  type AutoFillAddressKind = "billing" | "shipping";
  type AutoFillBase = "" | "off" | "on";
  type AutoFillContactField =
    | "email"
    | "tel"
    | "tel-area-code"
    | "tel-country-code"
    | "tel-extension"
    | "tel-local"
    | "tel-local-prefix"
    | "tel-local-suffix"
    | "tel-national";
  type AutoFillContactKind = "home" | "mobile" | "work";
  type AutoFillCredentialField = "webauthn";
  type AutoFillNormalField =
    | "additional-name"
    | "address-level1"
    | "address-level2"
    | "address-level3"
    | "address-level4"
    | "address-line1"
    | "address-line2"
    | "address-line3"
    | "bday-day"
    | "bday-month"
    | "bday-year"
    | "cc-csc"
    | "cc-exp"
    | "cc-exp-month"
    | "cc-exp-year"
    | "cc-family-name"
    | "cc-given-name"
    | "cc-name"
    | "cc-number"
    | "cc-type"
    | "country"
    | "country-name"
    | "current-password"
    | "family-name"
    | "given-name"
    | "honorific-prefix"
    | "honorific-suffix"
    | "name"
    | "new-password"
    | "one-time-code"
    | "organization"
    | "postal-code"
    | "street-address"
    | "transaction-amount"
    | "transaction-currency"
    | "username";
  type OptionalPrefixToken<T extends string> = `${T} ` | "";
  type OptionalPostfixToken<T extends string> = ` ${T}` | "";
  type AutoFillField =
    | AutoFillNormalField
    | `${OptionalPrefixToken<AutoFillContactKind>}${AutoFillContactField}`;
  type AutoFillSection = `section-${string}`;
  type AutoFill =
    | AutoFillBase
    | `${OptionalPrefixToken<AutoFillSection>}${OptionalPrefixToken<
      AutoFillAddressKind
    >}${AutoFillField}${OptionalPostfixToken<AutoFillCredentialField>}`;
  type HTMLInputAutoCompleteAttribute = AutoFill | (string & {});

  interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
    accept?: string | undefined;
    alt?: string | undefined;
    autoComplete?: HTMLInputAutoCompleteAttribute | undefined;
    capture?: boolean | "user" | "environment" | undefined; // https://www.w3.org/TR/html-media-capture/#the-capture-attribute
    checked?: boolean | undefined;
    disabled?: boolean | undefined;
    form?: string | undefined;
    formAction?:
      | string
      | undefined;
    formEncType?: string | undefined;
    formMethod?: string | undefined;
    formNoValidate?: boolean | undefined;
    formTarget?: string | undefined;
    height?: number | string | undefined;
    list?: string | undefined;
    max?: number | string | undefined;
    maxLength?: number | undefined;
    min?: number | string | undefined;
    minLength?: number | undefined;
    multiple?: boolean | undefined;
    name?: string | undefined;
    pattern?: string | undefined;
    placeholder?: string | undefined;
    readOnly?: boolean | undefined;
    required?: boolean | undefined;
    size?: number | undefined;
    src?: string | undefined;
    step?: number | string | undefined;
    type?: HTMLInputTypeAttribute | undefined;
    value?: string | readonly string[] | number | undefined;
    width?: number | string | undefined;

    // @TODO(events)
    //onChange?: ChangeEventHandler<T> | undefined;
  }

  interface KeygenHTMLAttributes<T> extends HTMLAttributes<T> {
    challenge?: string | undefined;
    disabled?: boolean | undefined;
    form?: string | undefined;
    keyType?: string | undefined;
    keyParams?: string | undefined;
    name?: string | undefined;
  }

  interface LabelHTMLAttributes<T> extends HTMLAttributes<T> {
    form?: string | undefined;
    htmlFor?: string | undefined;
  }

  interface LiHTMLAttributes<T> extends HTMLAttributes<T> {
    value?: string | readonly string[] | number | undefined;
    // For backwards compat with React li's
    key?: number;
  }

  interface LinkHTMLAttributes<T> extends HTMLAttributes<T> {
    as?: string | undefined;
    blocking?: "render" | (string & {}) | undefined;
    crossOrigin?: CrossOrigin;
    fetchPriority?: "high" | "low" | "auto";
    href?: string | undefined;
    hrefLang?: string | undefined;
    integrity?: string | undefined;
    media?: string | undefined;
    imageSrcSet?: string | undefined;
    imageSizes?: string | undefined;
    referrerPolicy?: HTMLAttributeReferrerPolicy | undefined;
    sizes?: string | undefined;
    type?: string | undefined;
    charSet?: string | undefined;
  }

  interface MapHTMLAttributes<T> extends HTMLAttributes<T> {
    name?: string | undefined;
  }

  interface MenuHTMLAttributes<T> extends HTMLAttributes<T> {
    type?: string | undefined;
  }

  interface MediaHTMLAttributes<T> extends HTMLAttributes<T> {
    autoPlay?: boolean | undefined;
    controls?: boolean | undefined;
    controlsList?: string | undefined;
    crossOrigin?: CrossOrigin;
    loop?: boolean | undefined;
    mediaGroup?: string | undefined;
    muted?: boolean | undefined;
    playsInline?: boolean | undefined;
    preload?: string | undefined;
    src?:
      | string
      | undefined;
  }

  interface MetaHTMLAttributes<T> extends HTMLAttributes<T> {
    charSet?: string | undefined;
    content?: string | undefined;
    httpEquiv?: string | undefined;
    media?: string | undefined;
    name?: string | undefined;
  }

  interface MeterHTMLAttributes<T> extends HTMLAttributes<T> {
    form?: string | undefined;
    high?: number | undefined;
    low?: number | undefined;
    max?: number | string | undefined;
    min?: number | string | undefined;
    optimum?: number | undefined;
    value?: string | readonly string[] | number | undefined;
  }

  interface QuoteHTMLAttributes<T> extends HTMLAttributes<T> {
    cite?: string | undefined;
  }

  interface ObjectHTMLAttributes<T> extends HTMLAttributes<T> {
    classID?: string | undefined;
    data?: string | undefined;
    form?: string | undefined;
    height?: number | string | undefined;
    name?: string | undefined;
    type?: string | undefined;
    useMap?: string | undefined;
    width?: number | string | undefined;
    wmode?: string | undefined;
  }

  interface OlHTMLAttributes<T> extends HTMLAttributes<T> {
    reversed?: boolean | undefined;
    start?: number | undefined;
    type?: "1" | "a" | "A" | "i" | "I" | undefined;
  }

  interface OptgroupHTMLAttributes<T> extends HTMLAttributes<T> {
    disabled?: boolean | undefined;
    label?: string | undefined;
  }

  interface OptionHTMLAttributes<T> extends HTMLAttributes<T> {
    disabled?: boolean | undefined;
    label?: string | undefined;
    selected?: boolean | undefined;
    value?: string | readonly string[] | number | undefined;
  }

  interface OutputHTMLAttributes<T> extends HTMLAttributes<T> {
    form?: string | undefined;
    htmlFor?: string | undefined;
    name?: string | undefined;
  }

  interface ParamHTMLAttributes<T> extends HTMLAttributes<T> {
    name?: string | undefined;
    value?: string | readonly string[] | number | undefined;
  }

  interface ProgressHTMLAttributes<T> extends HTMLAttributes<T> {
    max?: number | string | undefined;
    value?: string | readonly string[] | number | undefined;
  }

  interface SlotHTMLAttributes<T> extends HTMLAttributes<T> {
    name?: string | undefined;
  }

  interface ScriptHTMLAttributes<T> extends HTMLAttributes<T> {
    async?: boolean | undefined;
    blocking?: "render" | (string & {}) | undefined;
    /** @deprecated */
    charSet?: string | undefined;
    crossOrigin?: CrossOrigin;
    defer?: boolean | undefined;
    fetchPriority?: "high" | "low" | "auto" | undefined;
    integrity?: string | undefined;
    noModule?: boolean | undefined;
    referrerPolicy?: HTMLAttributeReferrerPolicy | undefined;
    src?: string | undefined;
    type?: string | undefined;
  }

  interface SelectHTMLAttributes<T> extends HTMLAttributes<T> {
    autoComplete?: string | undefined;
    disabled?: boolean | undefined;
    form?: string | undefined;
    multiple?: boolean | undefined;
    name?: string | undefined;
    required?: boolean | undefined;
    size?: number | undefined;
    value?: string | readonly string[] | number | undefined;
    // @TODO(events)
    //onChange?: ChangeEventHandler<T> | undefined;
  }

  interface SourceHTMLAttributes<T> extends HTMLAttributes<T> {
    height?: number | string | undefined;
    media?: string | undefined;
    sizes?: string | undefined;
    src?: string | undefined;
    srcSet?: string | undefined;
    type?: string | undefined;
    width?: number | string | undefined;
  }

  interface StyleHTMLAttributes<T> extends HTMLAttributes<T> {
    blocking?: "render" | (string & {}) | undefined;
    media?: string | undefined;
    scoped?: boolean | undefined;
    type?: string | undefined;

    // React props
    href?: string | undefined;
    precedence?: string | undefined;
  }

  interface TableHTMLAttributes<T> extends HTMLAttributes<T> {
    align?: "left" | "center" | "right" | undefined;
    bgcolor?: string | undefined;
    border?: number | undefined;
    cellPadding?: number | string | undefined;
    cellSpacing?: number | string | undefined;
    frame?: boolean | undefined;
    rules?: "none" | "groups" | "rows" | "columns" | "all" | undefined;
    summary?: string | undefined;
    width?: number | string | undefined;
  }

  interface TextareaHTMLAttributes<T> extends HTMLAttributes<T> {
    autoComplete?: string | undefined;
    cols?: number | undefined;
    dirName?: string | undefined;
    disabled?: boolean | undefined;
    form?: string | undefined;
    maxLength?: number | undefined;
    minLength?: number | undefined;
    name?: string | undefined;
    placeholder?: string | undefined;
    readOnly?: boolean | undefined;
    required?: boolean | undefined;
    rows?: number | undefined;
    value?: string | readonly string[] | number | undefined;
    wrap?: string | undefined;

    // @TODO(events)
    //onChange?: ChangeEventHandler<T> | undefined;
  }

  interface TdHTMLAttributes<T> extends HTMLAttributes<T> {
    align?: "left" | "center" | "right" | "justify" | "char" | undefined;
    colSpan?: number | undefined;
    headers?: string | undefined;
    rowSpan?: number | undefined;
    scope?: string | undefined;
    abbr?: string | undefined;
    height?: number | string | undefined;
    width?: number | string | undefined;
    valign?: "top" | "middle" | "bottom" | "baseline" | undefined;
  }

  interface ThHTMLAttributes<T> extends HTMLAttributes<T> {
    align?: "left" | "center" | "right" | "justify" | "char" | undefined;
    colSpan?: number | undefined;
    headers?: string | undefined;
    rowSpan?: number | undefined;
    scope?: string | undefined;
    abbr?: string | undefined;
  }

  interface TimeHTMLAttributes<T> extends HTMLAttributes<T> {
    dateTime?: string | undefined;
  }

  interface TrackHTMLAttributes<T> extends HTMLAttributes<T> {
    default?: boolean | undefined;
    kind?: string | undefined;
    label?: string | undefined;
    src?: string | undefined;
    srcLang?: string | undefined;
  }

  interface VideoHTMLAttributes<T> extends MediaHTMLAttributes<T> {
    height?: number | string | undefined;
    playsInline?: boolean | undefined;
    poster?: string | undefined;
    width?: number | string | undefined;
    disablePictureInPicture?: boolean | undefined;
    disableRemotePlayback?: boolean | undefined;

    // @TODO(events)
    //onResize?: ReactEventHandler<T> | undefined;
    // @TODO(events)
    //onResizeCapture?: ReactEventHandler<T> | undefined;
  }

  interface WebViewHTMLAttributes<T> extends HTMLAttributes<T> {
    allowFullScreen?: boolean | undefined;
    allowpopups?: boolean | undefined;
    autosize?: boolean | undefined;
    blinkfeatures?: string | undefined;
    disableblinkfeatures?: string | undefined;
    disableguestresize?: boolean | undefined;
    disablewebsecurity?: boolean | undefined;
    guestinstance?: string | undefined;
    httpreferrer?: string | undefined;
    nodeintegration?: boolean | undefined;
    partition?: string | undefined;
    plugins?: boolean | undefined;
    preload?: string | undefined;
    src?: string | undefined;
    useragent?: string | undefined;
    webpreferences?: string | undefined;
  }

  interface DOMAttributes<T> {
    // @TODO(events)
    /*
      // Clipboard Events
      onCopy?: ClipboardEventHandler<T> | undefined;
      onCopyCapture?: ClipboardEventHandler<T> | undefined;
      onCut?: ClipboardEventHandler<T> | undefined;
      onCutCapture?: ClipboardEventHandler<T> | undefined;
      onPaste?: ClipboardEventHandler<T> | undefined;
      onPasteCapture?: ClipboardEventHandler<T> | undefined;

      // Composition Events
      onCompositionEnd?: CompositionEventHandler<T> | undefined;
      onCompositionEndCapture?: CompositionEventHandler<T> | undefined;
      onCompositionStart?: CompositionEventHandler<T> | undefined;
      onCompositionStartCapture?: CompositionEventHandler<T> | undefined;
      onCompositionUpdate?: CompositionEventHandler<T> | undefined;
      onCompositionUpdateCapture?: CompositionEventHandler<T> | undefined;

      // Focus Events
      onFocus?: FocusEventHandler<T> | undefined;
      onFocusCapture?: FocusEventHandler<T> | undefined;
      onBlur?: FocusEventHandler<T> | undefined;
      onBlurCapture?: FocusEventHandler<T> | undefined;

      // Form Events
      onChange?: FormEventHandler<T> | undefined;
      onChangeCapture?: FormEventHandler<T> | undefined;
      onBeforeInput?: InputEventHandler<T> | undefined;
      onBeforeInputCapture?: FormEventHandler<T> | undefined;
      onInput?: FormEventHandler<T> | undefined;
      onInputCapture?: FormEventHandler<T> | undefined;
      onReset?: FormEventHandler<T> | undefined;
      onResetCapture?: FormEventHandler<T> | undefined;
      onSubmit?: FormEventHandler<T> | undefined;
      onSubmitCapture?: FormEventHandler<T> | undefined;
      onInvalid?: FormEventHandler<T> | undefined;
      onInvalidCapture?: FormEventHandler<T> | undefined;

      // Image Events
      onLoad?: ReactEventHandler<T> | undefined;
      onLoadCapture?: ReactEventHandler<T> | undefined;
      onError?: ReactEventHandler<T> | undefined; // also a Media Event
      onErrorCapture?: ReactEventHandler<T> | undefined; // also a Media Event

      // Keyboard Events
      onKeyDown?: KeyboardEventHandler<T> | undefined;
      onKeyDownCapture?: KeyboardEventHandler<T> | undefined;
      // @deprecated Use `onKeyUp` or `onKeyDown` instead
      onKeyPress?: KeyboardEventHandler<T> | undefined;
      // @deprecated Use `onKeyUpCapture` or `onKeyDownCapture` instead
      onKeyPressCapture?: KeyboardEventHandler<T> | undefined;
      onKeyUp?: KeyboardEventHandler<T> | undefined;
      onKeyUpCapture?: KeyboardEventHandler<T> | undefined;

      // Media Events
      onAbort?: ReactEventHandler<T> | undefined;
      onAbortCapture?: ReactEventHandler<T> | undefined;
      onCanPlay?: ReactEventHandler<T> | undefined;
      onCanPlayCapture?: ReactEventHandler<T> | undefined;
      onCanPlayThrough?: ReactEventHandler<T> | undefined;
      onCanPlayThroughCapture?: ReactEventHandler<T> | undefined;
      onDurationChange?: ReactEventHandler<T> | undefined;
      onDurationChangeCapture?: ReactEventHandler<T> | undefined;
      onEmptied?: ReactEventHandler<T> | undefined;
      onEmptiedCapture?: ReactEventHandler<T> | undefined;
      onEncrypted?: ReactEventHandler<T> | undefined;
      onEncryptedCapture?: ReactEventHandler<T> | undefined;
      onEnded?: ReactEventHandler<T> | undefined;
      onEndedCapture?: ReactEventHandler<T> | undefined;
      onLoadedData?: ReactEventHandler<T> | undefined;
      onLoadedDataCapture?: ReactEventHandler<T> | undefined;
      onLoadedMetadata?: ReactEventHandler<T> | undefined;
      onLoadedMetadataCapture?: ReactEventHandler<T> | undefined;
      onLoadStart?: ReactEventHandler<T> | undefined;
      onLoadStartCapture?: ReactEventHandler<T> | undefined;
      onPause?: ReactEventHandler<T> | undefined;
      onPauseCapture?: ReactEventHandler<T> | undefined;
      onPlay?: ReactEventHandler<T> | undefined;
      onPlayCapture?: ReactEventHandler<T> | undefined;
      onPlaying?: ReactEventHandler<T> | undefined;
      onPlayingCapture?: ReactEventHandler<T> | undefined;
      onProgress?: ReactEventHandler<T> | undefined;
      onProgressCapture?: ReactEventHandler<T> | undefined;
      onRateChange?: ReactEventHandler<T> | undefined;
      onRateChangeCapture?: ReactEventHandler<T> | undefined;
      onSeeked?: ReactEventHandler<T> | undefined;
      onSeekedCapture?: ReactEventHandler<T> | undefined;
      onSeeking?: ReactEventHandler<T> | undefined;
      onSeekingCapture?: ReactEventHandler<T> | undefined;
      onStalled?: ReactEventHandler<T> | undefined;
      onStalledCapture?: ReactEventHandler<T> | undefined;
      onSuspend?: ReactEventHandler<T> | undefined;
      onSuspendCapture?: ReactEventHandler<T> | undefined;
      onTimeUpdate?: ReactEventHandler<T> | undefined;
      onTimeUpdateCapture?: ReactEventHandler<T> | undefined;
      onVolumeChange?: ReactEventHandler<T> | undefined;
      onVolumeChangeCapture?: ReactEventHandler<T> | undefined;
      onWaiting?: ReactEventHandler<T> | undefined;
      onWaitingCapture?: ReactEventHandler<T> | undefined;

      // MouseEvents
      onAuxClick?: MouseEventHandler<T> | undefined;
      onAuxClickCapture?: MouseEventHandler<T> | undefined;
      onClick?: MouseEventHandler<T> | undefined;
      onClickCapture?: MouseEventHandler<T> | undefined;
      onContextMenu?: MouseEventHandler<T> | undefined;
      onContextMenuCapture?: MouseEventHandler<T> | undefined;
      onDoubleClick?: MouseEventHandler<T> | undefined;
      onDoubleClickCapture?: MouseEventHandler<T> | undefined;
      onDrag?: DragEventHandler<T> | undefined;
      onDragCapture?: DragEventHandler<T> | undefined;
      onDragEnd?: DragEventHandler<T> | undefined;
      onDragEndCapture?: DragEventHandler<T> | undefined;
      onDragEnter?: DragEventHandler<T> | undefined;
      onDragEnterCapture?: DragEventHandler<T> | undefined;
      onDragExit?: DragEventHandler<T> | undefined;
      onDragExitCapture?: DragEventHandler<T> | undefined;
      onDragLeave?: DragEventHandler<T> | undefined;
      onDragLeaveCapture?: DragEventHandler<T> | undefined;
      onDragOver?: DragEventHandler<T> | undefined;
      onDragOverCapture?: DragEventHandler<T> | undefined;
      onDragStart?: DragEventHandler<T> | undefined;
      onDragStartCapture?: DragEventHandler<T> | undefined;
      onDrop?: DragEventHandler<T> | undefined;
      onDropCapture?: DragEventHandler<T> | undefined;
      onMouseDown?: MouseEventHandler<T> | undefined;
      onMouseDownCapture?: MouseEventHandler<T> | undefined;
      onMouseEnter?: MouseEventHandler<T> | undefined;
      onMouseLeave?: MouseEventHandler<T> | undefined;
      onMouseMove?: MouseEventHandler<T> | undefined;
      onMouseMoveCapture?: MouseEventHandler<T> | undefined;
      onMouseOut?: MouseEventHandler<T> | undefined;
      onMouseOutCapture?: MouseEventHandler<T> | undefined;
      onMouseOver?: MouseEventHandler<T> | undefined;
      onMouseOverCapture?: MouseEventHandler<T> | undefined;
      onMouseUp?: MouseEventHandler<T> | undefined;
      onMouseUpCapture?: MouseEventHandler<T> | undefined;

      // Selection Events
      onSelect?: ReactEventHandler<T> | undefined;
      onSelectCapture?: ReactEventHandler<T> | undefined;

      // Touch Events
      onTouchCancel?: TouchEventHandler<T> | undefined;
      onTouchCancelCapture?: TouchEventHandler<T> | undefined;
      onTouchEnd?: TouchEventHandler<T> | undefined;
      onTouchEndCapture?: TouchEventHandler<T> | undefined;
      onTouchMove?: TouchEventHandler<T> | undefined;
      onTouchMoveCapture?: TouchEventHandler<T> | undefined;
      onTouchStart?: TouchEventHandler<T> | undefined;
      onTouchStartCapture?: TouchEventHandler<T> | undefined;

      // Pointer Events
      onPointerDown?: PointerEventHandler<T> | undefined;
      onPointerDownCapture?: PointerEventHandler<T> | undefined;
      onPointerMove?: PointerEventHandler<T> | undefined;
      onPointerMoveCapture?: PointerEventHandler<T> | undefined;
      onPointerUp?: PointerEventHandler<T> | undefined;
      onPointerUpCapture?: PointerEventHandler<T> | undefined;
      onPointerCancel?: PointerEventHandler<T> | undefined;
      onPointerCancelCapture?: PointerEventHandler<T> | undefined;
      onPointerEnter?: PointerEventHandler<T> | undefined;
      onPointerLeave?: PointerEventHandler<T> | undefined;
      onPointerOver?: PointerEventHandler<T> | undefined;
      onPointerOverCapture?: PointerEventHandler<T> | undefined;
      onPointerOut?: PointerEventHandler<T> | undefined;
      onPointerOutCapture?: PointerEventHandler<T> | undefined;
      onGotPointerCapture?: PointerEventHandler<T> | undefined;
      onGotPointerCaptureCapture?: PointerEventHandler<T> | undefined;
      onLostPointerCapture?: PointerEventHandler<T> | undefined;
      onLostPointerCaptureCapture?: PointerEventHandler<T> | undefined;

      // UI Events
      onScroll?: UIEventHandler<T> | undefined;
      onScrollCapture?: UIEventHandler<T> | undefined;
      onScrollEnd?: UIEventHandler<T> | undefined;
      onScrollEndCapture?: UIEventHandler<T> | undefined;

      // Wheel Events
      onWheel?: WheelEventHandler<T> | undefined;
      onWheelCapture?: WheelEventHandler<T> | undefined;

      // Animation Events
      onAnimationStart?: AnimationEventHandler<T> | undefined;
      onAnimationStartCapture?: AnimationEventHandler<T> | undefined;
      onAnimationEnd?: AnimationEventHandler<T> | undefined;
      onAnimationEndCapture?: AnimationEventHandler<T> | undefined;
      onAnimationIteration?: AnimationEventHandler<T> | undefined;
      onAnimationIterationCapture?: AnimationEventHandler<T> | undefined;

      // Toggle Events
      onToggle?: ToggleEventHandler<T> | undefined;
      onBeforeToggle?: ToggleEventHandler<T> | undefined;

      // Transition Events
      onTransitionCancel?: TransitionEventHandler<T> | undefined;
      onTransitionCancelCapture?: TransitionEventHandler<T> | undefined;
      onTransitionEnd?: TransitionEventHandler<T> | undefined;
      onTransitionEndCapture?: TransitionEventHandler<T> | undefined;
      onTransitionRun?: TransitionEventHandler<T> | undefined;
      onTransitionRunCapture?: TransitionEventHandler<T> | undefined;
      onTransitionStart?: TransitionEventHandler<T> | undefined;
      onTransitionStartCapture?: TransitionEventHandler<T> | undefined;
      */
  }
}

// Helper type that allows any combination of OpaqueRef, Cell, and Stream wrappers
// Supports arbitrary nesting like OpaqueRef<OpaqueRef<Cell<T>>>
type InnerCellLike<T> =
  | OpaqueRefMethods<T>
  | Opaque<T>
  | OpaqueRef<T>
  | Cell<T>
  | Stream<T>;
type CellLike<T> =
  | InnerCellLike<T>
  | InnerCellLike<InnerCellLike<T>>
  | InnerCellLike<T[]>;

interface CTHTMLElement extends CTDOM.HTMLElement {}
// Extend this to add attributes to only the CT elements.
interface CTHTMLAttributes<T> extends CTDOM.HTMLAttributes<T> {}

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

type HandlerEvent<T> = {
  detail: T;
};

// `Charm` is not a recipe type.
type Charm = any;

type OutlinerNode = {
  body: string;
  children: OutlinerNode[];
  attachments: Charm[];
};

type CtListItem = {
  title: string;
  done?: boolean;
};

interface CTOutlinerElement extends CTHTMLElement {}
interface CTListElement extends CTHTMLElement {}
interface CTListItemElement extends CTHTMLElement {}
interface CTInputElement extends CTHTMLElement {}
interface CTInputLegacyElement extends CTHTMLElement {}
interface CTCheckboxElement extends CTHTMLElement {}
interface CTSelectElement extends CTHTMLElement {}
interface CTToolsChipElement extends CTHTMLElement {}
interface CTHeadingElement extends CTHTMLElement {}
interface CTCollapsibleElement extends CTHTMLElement {}
interface CTThemeElement extends CTHTMLElement {}
interface CTCodeEditorElement extends CTHTMLElement {}
interface CTScreenElement extends CTHTMLElement {}
interface CTAutoLayoutElement extends CTHTMLElement {}
interface CTButtonElement extends CTHTMLElement {}
interface CTIFrameElement extends CTHTMLElement {}
interface CTHStackElement extends CTHTMLElement {}
interface CTFabElement extends CTHTMLElement {}
interface CTChevronButtonElement extends CTHTMLElement {}
interface CTCardElement extends CTHTMLElement {}
interface CTVStackElement extends CTHTMLElement {}
interface CTMessageInputElement extends CTHTMLElement {}
interface CTToolbarElement extends CTHTMLElement {}
interface CTKbdElement extends CTHTMLElement {}
interface CTKeybindElement extends CTHTMLElement {}
interface CTRenderElement extends CTHTMLElement {}
interface CTChatMessageElement extends CTHTMLElement {}
interface CTVScrollElement extends CTHTMLElement {}
interface CTSendMessageElement extends CTHTMLElement {}
interface CTTextElement extends CTHTMLElement {}
interface CTTableElement extends CTHTMLElement {}
interface CTTagsElement extends CTHTMLElement {}
interface CTPromptInputElement extends CTHTMLElement {}
interface CTChatElement extends CTHTMLElement {}
interface CTAttachmentsBarElement extends CTHTMLElement {}
interface CTCTCollapsibleElement extends CTHTMLElement {}
interface CTFragmentElement extends CTHTMLElement {}
interface CTUpdaterElement extends CTHTMLElement {}

interface CTUpdaterAttributes<T> extends CTHTMLAttributes<T> {
  "integration"?: string;
  "$state"?: CellLike<any>;
}

interface CTChatAttributes<T> extends CTHTMLAttributes<T> {
  "$messages"?: CellLike<any>;
  "pending"?: boolean;
  "theme"?: CTThemeInput;
  "tools"?: any;
}

interface CTPromptInputAttributes<T> extends CTHTMLAttributes<T> {
  "placeholder"?: string;
  "buttonText"?: string;
  "value"?: string;
  "rows"?: number;
  "$mentionable"?: CellLike<any>;
  "modelItems"?: any[];
  "$model"?: CellLike<string>;
  "maxRows"?: number;
  "disabled"?: boolean;
  "autoResize"?: boolean;
  "pending"?: boolean;
}

interface CTAttachmentsBarAttributes<T> extends CTHTMLAttributes<T> {
  "removable"?: boolean;
  "attachments"?: any;
}

interface CTTagsAttributes<T> extends CTHTMLAttributes<T> {
  "tags"?: string[];
  "onct-change"?: CellLike<HandlerEvent<any>>;
}

interface CTToolbarAttributes<T> extends CTHTMLAttributes<T> {
  "dense"?: boolean;
  "sticky"?: boolean;
}

interface CTTableAttributes<T> extends CTHTMLAttributes<T> {
  "full-width"?: boolean;
  "hover"?: boolean;
}

interface CTKeybindAttributes<T> extends CTHTMLAttributes<T> {
  "code": string; // Could be tighter e.g. `Key${string}`
  "ctrl"?: boolean;
  "meta"?: boolean;
  "alt"?: boolean;
  "preventDefault"?: boolean;
}

type TailwindNumberType =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 8
  | 10
  | 12
  | 16
  | 20
  | 24
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "8"
  | "10"
  | "12"
  | "16"
  | "20"
  | "24";
interface CTStackAttributes<T> extends CTHTMLAttributes<T> {
  "gap"?: TailwindNumberType;
  "padding"?: TailwindNumberType;
  "align"?: "start" | "center" | "end" | "stretch" | "baseline";
  "justify"?: "start" | "center" | "end" | "between" | "around" | "evenly";
  "wrap"?: boolean;
  "reverse"?: boolean;
}

interface CTStackLegacyAttributes<T> extends CTHTMLAttributes<T> {
  "gap"?: "sm" | "md" | "lg" | "xl" | "none";
  "pad"?: "md" | "lg" | "xl" | "2xl";
}

interface CTMessageInputAttributes<T> extends CTHTMLAttributes<T> {
  "name"?: string;
  "placeholder"?: string;
  "appearance"?: "rounded";
}

interface CTSendMessageAttributes<T> extends CTHTMLAttributes<T> {
  "name"?: string;
  "placeholder"?: string;
  "appearance"?: "rounded";
  "onmessagesend"?: CellLike<HandlerEvent<{ message: string }>>;
}

interface CTScrollAttributes<T> extends CTHTMLAttributes<T> {
  "flex"?: boolean;
  "showScrollbar"?: boolean;
  "fadeEdges"?: boolean;
  "snapToBottom"?: boolean;
}

interface CTOutlinerAttributes<T> extends CTHTMLAttributes<T> {
  "$value": CellLike<{ root: OutlinerNode }>;
  "$mentionable"?: CellLike<Charm[]>;
  "oncharm-link-click"?: CellLike<HandlerEvent<{ charm: Cell<Charm> }>>;
}

interface CTChatMessageAttributes<T> extends CTHTMLAttributes<T> {
  "role"?: "user" | "assistant";
  "content"?: string;
  "avatar"?: string;
  "name"?: string;
  "compact"?: boolean;
  "pending"?: boolean;
}

interface CTButtonAttributes<T> extends CTHTMLAttributes<T> {
  "variant"?:
    | "default"
    | "destructive"
    | "outline"
    | "secondary"
    | "ghost"
    | "link"
    | "pill";
  "size"?: "default" | "sm" | "lg" | "icon";
  "disabled"?: boolean;
  "type"?: "button" | "submit" | "reset";
}

interface CTIframeAttributes<T> extends CTHTMLAttributes<T> {
  "src": string;
  "$context": CellLike<any>;
}

interface CTRenderAttributes<T> extends CTHTMLAttributes<T> {
  "$cell": CellLike<any>;
}

interface CTListAttributes<T> extends CTHTMLAttributes<T> {
  "$value": CellLike<CtListItem[]>;
  /** setting this allows editing items inline */
  "editable"?: boolean;
  /** setting this hides the 'add item' form built into the list */
  "readonly"?: boolean;
  "title"?: string;
  "onct-remove-item"?: CellLike<HandlerEvent<{ item: CtListItem }>>;
}

interface CTListItemAttributes<T> extends CTHTMLAttributes<T> {
  "selected"?: boolean;
  "active"?: boolean;
  "disabled"?: boolean;
  /** Fired when the row is activated (click/Enter/Space) */
  "onct-activate"?: any;
}

interface CTFabAttributes<T> extends CTHTMLAttributes<T> {
  "expanded"?: boolean;
  "variant"?: "default" | "primary";
  "position"?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  "pending"?: boolean;
  "$previewMessage"?: CellLike<string>;
}

interface CTChevronButtonAttributes<T> extends CTHTMLAttributes<T> {
  "expanded"?: boolean;
  "loading"?: boolean;
}

interface CTInputAttributes<T> extends CTHTMLAttributes<T> {
  "$value"?: CellLike<string>;
  "customStyle"?: string; // bf: I think this is going to go away one day soon
  "type"?: string;
  "placeholder"?: string;
  "value"?: string;
  "disabled"?: boolean;
  "readonly"?: boolean;
  "error"?: boolean;
  "name"?: string;
  "required"?: boolean;
  "autofocus"?: boolean;
  "autocomplete"?: string;
  "min"?: string;
  "max"?: string;
  "step"?: string;
  "pattern"?: string;
  "maxlength"?: string;
  "minlength"?: string;
  "inputmode"?: string;
  "size"?: number;
  "multiple"?: boolean;
  "accept"?: string;
  "list"?: string;
  "spellcheck"?: boolean;
  "validationPattern"?: string;
  "showValidation"?: boolean;
  "timingStrategy"?: string;
  "timingDelay"?: number;
  "onct-change"?: any;
  "onct-focus"?: any;
  "onct-blur"?: any;
  "onct-keydown"?: any;
  "onct-submit"?: any;
  "onct-invalid"?: any;
}

interface CTInputLegacyAttributes<T> extends CTHTMLAttributes<T> {
  "value"?: string;
  "placeholder"?: string;
  "appearance"?: string;
  "customStyle"?: string;
}

interface CTCheckboxAttributes<T> extends CTHTMLAttributes<T> {
  "$checked"?: CellLike<boolean>;
  "checked"?: boolean;
  "disabled"?: boolean;
  "indeterminate"?: boolean;
  "name"?: string;
  "value"?: string;
  "onct-change"?: any;
}

interface CTSelectAttributes<T> extends CTHTMLAttributes<T> {
  "$value": CellLike<any | any[]>;
  "items": { label: string; value: any }[];
  "multiple"?: boolean;
  "onct-change"?: CellLike<
    HandlerEvent<
      { items: { label: string; value: any }[]; value: any | any[] }
    >
  >;
}

interface CTToolsChipAttributes<T> extends CTHTMLAttributes<T> {
  "label"?: string;
  "show-count"?: boolean;
  "open-on-hover"?: boolean;
  "toggle-on-click"?: boolean;
  "close-delay"?: number;
  /**
   * Accepts either:
   * - Array: { name, description?, schema? }[]
   * - Native map: { [toolName]: { handler?: any, pattern?: any } | any }
   */
  "tools"?:
    | { name: string; description?: string; schema?: unknown }[]
    | Record<string, { handler?: unknown; pattern?: unknown } | any>;
}

interface CTHeadingAttributes<T> extends CTHTMLAttributes<T> {
  "level"?: number;
  "no-margin"?: boolean;
}

interface CTCollapsibleAttributes<T> extends CTHTMLAttributes<T> {
  "open"?: boolean;
  "disabled"?: boolean;
  "onct-toggle"?: any;
}

interface CTThemeAttributes<T> extends CTHTMLAttributes<T> {
  theme?: CTThemeInput;
}

interface CTCodeEditorAttributes<T> extends CTHTMLAttributes<T> {
  "$value"?: CellLike<string>;
  "value"?: string;
  "language"?: string;
  "disabled"?: boolean;
  "readonly"?: boolean;
  "placeholder"?: string;
  "timingStrategy"?: string;
  "timingDelay"?: number;
  "$mentionable"?: CellLike<Charm[]>;
  "$mentioned"?: CellLike<Charm[]>;
  "$pattern"?: CellLike<any>;
  "pattern"?: any;
  "wordWrap"?: boolean;
  "lineNumbers"?: boolean;
  "maxLineWidth"?: number;
  "tabSize"?: number;
  "tabIndent"?: boolean;
  "theme"?: "light" | "dark";
  "onct-change"?: any;
  "onct-focus"?: any;
  "onct-blur"?: any;
  "onbacklink-click"?: any;
  "onbacklink-create"?: any;
}

interface CTAutoLayoutAttributes<T> extends CTHTMLAttributes<T> {
  "tabNames"?: string[];
  "leftOpen"?: boolean;
  "rightOpen"?: boolean;
}

/**
 * Typings for native DOM elements.
 * Notably, this does not propagate to IDEs when defined in another file and
 * extended here. Must be defined within the same file(?)
 */
interface DOMIntrinsicElements {
  // HTML
  a: CTDOM.DetailedHTMLProps<
    CTDOM.AnchorHTMLAttributes<CTDOM.HTMLAnchorElement>,
    CTDOM.HTMLAnchorElement
  >;
  abbr: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  address: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  area: CTDOM.DetailedHTMLProps<
    CTDOM.AreaHTMLAttributes<CTDOM.HTMLAreaElement>,
    CTDOM.HTMLAreaElement
  >;
  article: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  aside: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  audio: CTDOM.DetailedHTMLProps<
    CTDOM.AudioHTMLAttributes<CTDOM.HTMLAudioElement>,
    CTDOM.HTMLAudioElement
  >;
  b: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  base: CTDOM.DetailedHTMLProps<
    CTDOM.BaseHTMLAttributes<CTDOM.HTMLBaseElement>,
    CTDOM.HTMLBaseElement
  >;
  bdi: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  bdo: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  big: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  blockquote: CTDOM.DetailedHTMLProps<
    CTDOM.BlockquoteHTMLAttributes<CTDOM.HTMLQuoteElement>,
    CTDOM.HTMLQuoteElement
  >;
  body: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLBodyElement>,
    CTDOM.HTMLBodyElement
  >;
  br: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLBRElement>,
    CTDOM.HTMLBRElement
  >;
  button: CTDOM.DetailedHTMLProps<
    CTDOM.ButtonHTMLAttributes<CTDOM.HTMLButtonElement>,
    CTDOM.HTMLButtonElement
  >;
  canvas: CTDOM.DetailedHTMLProps<
    CTDOM.CanvasHTMLAttributes<CTDOM.HTMLCanvasElement>,
    CTDOM.HTMLCanvasElement
  >;
  caption: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  center: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  cite: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  code: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  col: CTDOM.DetailedHTMLProps<
    CTDOM.ColHTMLAttributes<CTDOM.HTMLTableColElement>,
    CTDOM.HTMLTableColElement
  >;
  colgroup: CTDOM.DetailedHTMLProps<
    CTDOM.ColgroupHTMLAttributes<CTDOM.HTMLTableColElement>,
    CTDOM.HTMLTableColElement
  >;
  data: CTDOM.DetailedHTMLProps<
    CTDOM.DataHTMLAttributes<CTDOM.HTMLDataElement>,
    CTDOM.HTMLDataElement
  >;
  datalist: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLDataListElement>,
    CTDOM.HTMLDataListElement
  >;
  dd: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  del: CTDOM.DetailedHTMLProps<
    CTDOM.DelHTMLAttributes<CTDOM.HTMLModElement>,
    CTDOM.HTMLModElement
  >;
  details: CTDOM.DetailedHTMLProps<
    CTDOM.DetailsHTMLAttributes<CTDOM.HTMLDetailsElement>,
    CTDOM.HTMLDetailsElement
  >;
  dfn: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  dialog: CTDOM.DetailedHTMLProps<
    CTDOM.DialogHTMLAttributes<CTDOM.HTMLDialogElement>,
    CTDOM.HTMLDialogElement
  >;
  div: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLDivElement>,
    CTDOM.HTMLDivElement
  >;
  dl: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLDListElement>,
    CTDOM.HTMLDListElement
  >;
  dt: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  em: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  embed: CTDOM.DetailedHTMLProps<
    CTDOM.EmbedHTMLAttributes<CTDOM.HTMLEmbedElement>,
    CTDOM.HTMLEmbedElement
  >;
  fieldset: CTDOM.DetailedHTMLProps<
    CTDOM.FieldsetHTMLAttributes<CTDOM.HTMLFieldSetElement>,
    CTDOM.HTMLFieldSetElement
  >;
  figcaption: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  figure: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  footer: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  form: CTDOM.DetailedHTMLProps<
    CTDOM.FormHTMLAttributes<CTDOM.HTMLFormElement>,
    CTDOM.HTMLFormElement
  >;
  h1: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLHeadingElement>,
    CTDOM.HTMLHeadingElement
  >;
  h2: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLHeadingElement>,
    CTDOM.HTMLHeadingElement
  >;
  h3: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLHeadingElement>,
    CTDOM.HTMLHeadingElement
  >;
  h4: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLHeadingElement>,
    CTDOM.HTMLHeadingElement
  >;
  h5: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLHeadingElement>,
    CTDOM.HTMLHeadingElement
  >;
  h6: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLHeadingElement>,
    CTDOM.HTMLHeadingElement
  >;
  head: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLHeadElement>,
    CTDOM.HTMLHeadElement
  >;
  header: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  hgroup: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  hr: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLHRElement>,
    CTDOM.HTMLHRElement
  >;
  html: CTDOM.DetailedHTMLProps<
    CTDOM.HtmlHTMLAttributes<CTDOM.HTMLHtmlElement>,
    CTDOM.HTMLHtmlElement
  >;
  i: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  iframe: CTDOM.DetailedHTMLProps<
    CTDOM.IframeHTMLAttributes<CTDOM.HTMLIFrameElement>,
    CTDOM.HTMLIFrameElement
  >;
  img: CTDOM.DetailedHTMLProps<
    CTDOM.ImgHTMLAttributes<CTDOM.HTMLImageElement>,
    CTDOM.HTMLImageElement
  >;
  input: CTDOM.DetailedHTMLProps<
    CTDOM.InputHTMLAttributes<CTDOM.HTMLInputElement>,
    CTDOM.HTMLInputElement
  >;
  ins: CTDOM.DetailedHTMLProps<
    CTDOM.InsHTMLAttributes<CTDOM.HTMLModElement>,
    CTDOM.HTMLModElement
  >;
  kbd: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  keygen: CTDOM.DetailedHTMLProps<
    CTDOM.KeygenHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  label: CTDOM.DetailedHTMLProps<
    CTDOM.LabelHTMLAttributes<CTDOM.HTMLLabelElement>,
    CTDOM.HTMLLabelElement
  >;
  legend: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLLegendElement>,
    CTDOM.HTMLLegendElement
  >;
  li: CTDOM.DetailedHTMLProps<
    CTDOM.LiHTMLAttributes<CTDOM.HTMLLIElement>,
    CTDOM.HTMLLIElement
  >;
  link: CTDOM.DetailedHTMLProps<
    CTDOM.LinkHTMLAttributes<CTDOM.HTMLLinkElement>,
    CTDOM.HTMLLinkElement
  >;
  main: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  map: CTDOM.DetailedHTMLProps<
    CTDOM.MapHTMLAttributes<CTDOM.HTMLMapElement>,
    CTDOM.HTMLMapElement
  >;
  mark: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  menu: CTDOM.DetailedHTMLProps<
    CTDOM.MenuHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  menuitem: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  meta: CTDOM.DetailedHTMLProps<
    CTDOM.MetaHTMLAttributes<CTDOM.HTMLMetaElement>,
    CTDOM.HTMLMetaElement
  >;
  meter: CTDOM.DetailedHTMLProps<
    CTDOM.MeterHTMLAttributes<CTDOM.HTMLMeterElement>,
    CTDOM.HTMLMeterElement
  >;
  nav: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  noindex: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  noscript: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  object: CTDOM.DetailedHTMLProps<
    CTDOM.ObjectHTMLAttributes<CTDOM.HTMLObjectElement>,
    CTDOM.HTMLObjectElement
  >;
  ol: CTDOM.DetailedHTMLProps<
    CTDOM.OlHTMLAttributes<CTDOM.HTMLOListElement>,
    CTDOM.HTMLOListElement
  >;
  optgroup: CTDOM.DetailedHTMLProps<
    CTDOM.OptgroupHTMLAttributes<CTDOM.HTMLOptGroupElement>,
    CTDOM.HTMLOptGroupElement
  >;
  option: CTDOM.DetailedHTMLProps<
    CTDOM.OptionHTMLAttributes<CTDOM.HTMLOptionElement>,
    CTDOM.HTMLOptionElement
  >;
  output: CTDOM.DetailedHTMLProps<
    CTDOM.OutputHTMLAttributes<CTDOM.HTMLOutputElement>,
    CTDOM.HTMLOutputElement
  >;
  p: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLParagraphElement>,
    CTDOM.HTMLParagraphElement
  >;
  param: CTDOM.DetailedHTMLProps<
    CTDOM.ParamHTMLAttributes<CTDOM.HTMLParamElement>,
    CTDOM.HTMLParamElement
  >;
  picture: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  pre: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLPreElement>,
    CTDOM.HTMLPreElement
  >;
  progress: CTDOM.DetailedHTMLProps<
    CTDOM.ProgressHTMLAttributes<CTDOM.HTMLProgressElement>,
    CTDOM.HTMLProgressElement
  >;
  q: CTDOM.DetailedHTMLProps<
    CTDOM.QuoteHTMLAttributes<CTDOM.HTMLQuoteElement>,
    CTDOM.HTMLQuoteElement
  >;
  rp: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  rt: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  ruby: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  s: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  samp: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  search: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  slot: CTDOM.DetailedHTMLProps<
    CTDOM.SlotHTMLAttributes<CTDOM.HTMLSlotElement>,
    CTDOM.HTMLSlotElement
  >;
  script: CTDOM.DetailedHTMLProps<
    CTDOM.ScriptHTMLAttributes<CTDOM.HTMLScriptElement>,
    CTDOM.HTMLScriptElement
  >;
  section: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  select: CTDOM.DetailedHTMLProps<
    CTDOM.SelectHTMLAttributes<CTDOM.HTMLSelectElement>,
    CTDOM.HTMLSelectElement
  >;
  small: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  source: CTDOM.DetailedHTMLProps<
    CTDOM.SourceHTMLAttributes<CTDOM.HTMLSourceElement>,
    CTDOM.HTMLSourceElement
  >;
  span: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLSpanElement>,
    CTDOM.HTMLSpanElement
  >;
  strong: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  style: CTDOM.DetailedHTMLProps<
    CTDOM.StyleHTMLAttributes<CTDOM.HTMLStyleElement>,
    CTDOM.HTMLStyleElement
  >;
  sub: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  summary: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  sup: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  table: CTDOM.DetailedHTMLProps<
    CTDOM.TableHTMLAttributes<CTDOM.HTMLTableElement>,
    CTDOM.HTMLTableElement
  >;
  template: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLTemplateElement>,
    CTDOM.HTMLTemplateElement
  >;
  tbody: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLTableSectionElement>,
    CTDOM.HTMLTableSectionElement
  >;
  td: CTDOM.DetailedHTMLProps<
    CTDOM.TdHTMLAttributes<CTDOM.HTMLTableDataCellElement>,
    CTDOM.HTMLTableDataCellElement
  >;
  textarea: CTDOM.DetailedHTMLProps<
    CTDOM.TextareaHTMLAttributes<CTDOM.HTMLTextAreaElement>,
    CTDOM.HTMLTextAreaElement
  >;
  tfoot: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLTableSectionElement>,
    CTDOM.HTMLTableSectionElement
  >;
  th: CTDOM.DetailedHTMLProps<
    CTDOM.ThHTMLAttributes<CTDOM.HTMLTableHeaderCellElement>,
    CTDOM.HTMLTableHeaderCellElement
  >;
  thead: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLTableSectionElement>,
    CTDOM.HTMLTableSectionElement
  >;
  time: CTDOM.DetailedHTMLProps<
    CTDOM.TimeHTMLAttributes<CTDOM.HTMLTimeElement>,
    CTDOM.HTMLTimeElement
  >;
  title: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLTitleElement>,
    CTDOM.HTMLTitleElement
  >;
  tr: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLTableRowElement>,
    CTDOM.HTMLTableRowElement
  >;
  track: CTDOM.DetailedHTMLProps<
    CTDOM.TrackHTMLAttributes<CTDOM.HTMLTrackElement>,
    CTDOM.HTMLTrackElement
  >;
  u: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  ul: CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTDOM.HTMLUListElement>,
    CTDOM.HTMLUListElement
  >;
  "var": CTDOM.DetailedHTMLProps<
    CTHTMLAttributes<CTHTMLElement>,
    CTHTMLElement
  >;
  video: CTDOM.DetailedHTMLProps<
    CTDOM.VideoHTMLAttributes<CTDOM.HTMLVideoElement>,
    CTDOM.HTMLVideoElement
  >;
  wbr: CTDOM.DetailedHTMLProps<CTHTMLAttributes<CTHTMLElement>, CTHTMLElement>;
  webview: CTDOM.DetailedHTMLProps<
    CTDOM.WebViewHTMLAttributes<CTDOM.HTMLWebViewElement>,
    CTDOM.HTMLWebViewElement
  >;
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

    interface IntrinsicElements extends DOMIntrinsicElements {
      //[elemName: string]: any;
      "ct-outliner": CTDOM.DetailedHTMLProps<
        CTOutlinerAttributes<CTOutlinerElement>,
        CTOutlinerElement
      >;
      "ct-list": CTDOM.DetailedHTMLProps<
        CTListAttributes<CTListElement>,
        CTListElement
      >;
      "ct-list-item": CTDOM.DetailedHTMLProps<
        CTListItemAttributes<CTListItemElement>,
        CTListItemElement
      >;
      "ct-input": CTDOM.DetailedHTMLProps<
        CTInputAttributes<CTInputElement>,
        CTInputElement
      >;
      "ct-checkbox": CTDOM.DetailedHTMLProps<
        CTCheckboxAttributes<CTCheckboxElement>,
        CTCheckboxElement
      >;
      "ct-select": CTDOM.DetailedHTMLProps<
        CTSelectAttributes<CTSelectElement>,
        CTSelectElement
      >;
      "ct-tools-chip": CTDOM.DetailedHTMLProps<
        CTToolsChipAttributes<CTToolsChipElement>,
        CTToolsChipElement
      >;
      "ct-heading": CTDOM.DetailedHTMLProps<
        CTHeadingAttributes<CTHeadingElement>,
        CTHeadingElement
      >;
      "ct-collapsible": CTDOM.DetailedHTMLProps<
        CTCollapsibleAttributes<CTCollapsibleElement>,
        CTCollapsibleElement
      >;
      "ct-theme": CTDOM.DetailedHTMLProps<
        CTThemeAttributes<CTThemeElement>,
        CTThemeElement
      >;
      "ct-code-editor": CTDOM.DetailedHTMLProps<
        CTCodeEditorAttributes<CTCodeEditorElement>,
        CTCodeEditorElement
      >;
      "ct-screen": CTDOM.DetailedHTMLProps<
        CTHTMLAttributes<CTScreenElement>,
        CTScreenElement
      >;
      "ct-autolayout": CTDOM.DetailedHTMLProps<
        CTAutoLayoutAttributes<CTAutoLayoutElement>,
        CTAutoLayoutElement
      >;
      "ct-button": CTDOM.DetailedHTMLProps<
        CTButtonAttributes<CTButtonElement>,
        CTButtonElement
      >;
      "common-iframe": CTDOM.DetailedHTMLProps<
        CTIframeAttributes<CTIFrameElement>,
        CTIFrameElement
      >;
      "ct-fab": CTDOM.DetailedHTMLProps<
        CTFabAttributes<CTFabElement>,
        CTFabElement
      >;
      "ct-chevron-button": CTDOM.DetailedHTMLProps<
        CTChevronButtonAttributes<CTChevronButtonElement>,
        CTChevronButtonElement
      >;
      "ct-message-input": CTDOM.DetailedHTMLProps<
        CTMessageInputAttributes<CTMessageInputElement>,
        CTMessageInputElement
      >;
      "ct-chat-message": CTDOM.DetailedHTMLProps<
        CTChatMessageAttributes<CTChatMessageElement>,
        CTChatMessageElement
      >;
      "ct-card": CTDOM.DetailedHTMLProps<
        CTHTMLAttributes<CTCardElement>,
        CTCardElement
      >;
      "ct-toolbar": CTDOM.DetailedHTMLProps<
        CTToolbarAttributes<CTToolbarElement>,
        CTToolbarElement
      >;
      "ct-kbd": CTDOM.DetailedHTMLProps<
        CTHTMLAttributes<CTKbdElement>,
        CTKbdElement
      >;
      "ct-keybind": CTDOM.DetailedHTMLProps<
        CTKeybindAttributes<CTKeybindElement>,
        CTKeybindElement
      >;
      "ct-render": CTDOM.DetailedHTMLProps<
        CTRenderAttributes<CTRenderElement>,
        CTRenderElement
      >;
      "ct-vscroll": CTDOM.DetailedHTMLProps<
        CTScrollAttributes<CTVScrollElement>,
        CTVScrollElement
      >;
      "ct-hscroll": CTDOM.DetailedHTMLProps<
        CTScrollAttributes<CTVScrollElement>,
        CTVScrollElement
      >;
      "ct-text": CTDOM.DetailedHTMLProps<
        CTHTMLAttributes<CTTextElement>,
        CTTextElement
      >;
      "ct-table": CTDOM.DetailedHTMLProps<
        CTTableAttributes<CTTableElement>,
        CTTableElement
      >;
      "ct-tags": CTDOM.DetailedHTMLProps<
        CTTagsAttributes<CTTagsElement>,
        CTTagsElement
      >;
      "ct-prompt-input": CTDOM.DetailedHTMLProps<
        CTPromptInputAttributes<CTPromptInputElement>,
        CTPromptInputElement
      >;
      "ct-chat": CTDOM.DetailedHTMLProps<
        CTChatAttributes<CTChatElement>,
        CTChatElement
      >;
      "ct-attachments-bar": CTDOM.DetailedHTMLProps<
        CTAttachmentsBarAttributes<CTAttachmentsBarElement>,
        CTAttachmentsBarElement
      >;
      "ct-ct-collapsible": CTDOM.DetailedHTMLProps<
        CTHTMLAttributes<CTCTCollapsibleElement>,
        CTCTCollapsibleElement
      >;
      "common-fragment": CTDOM.DetailedHTMLProps<
        CTHTMLAttributes<CTFragmentElement>,
        CTFragmentElement
      >;
      "common-updater": CTDOM.DetailedHTMLProps<
        CTUpdaterAttributes<CTUpdaterElement>,
        CTUpdaterElement
      >;
      "common-input": CTDOM.DetailedHTMLProps<
        CTInputLegacyAttributes<CTInputLegacyElement>,
        CTInputLegacyElement
      >;
      "common-send-message": CTDOM.DetailedHTMLProps<
        CTSendMessageAttributes<CTSendMessageElement>,
        CTSendMessageElement
      >;
      // Define both `ct-` and `common-` variants
      "ct-hstack": CTDOM.DetailedHTMLProps<
        CTStackAttributes<CTHStackElement>,
        CTHStackElement
      >;
      "ct-vstack": CTDOM.DetailedHTMLProps<
        CTStackAttributes<CTVStackElement>,
        CTVStackElement
      >;
      "common-hstack": CTDOM.DetailedHTMLProps<
        CTStackLegacyAttributes<CTHStackElement>,
        CTHStackElement
      >;
      "common-vstack": CTDOM.DetailedHTMLProps<
        CTStackLegacyAttributes<CTVStackElement>,
        CTVStackElement
      >;
    }
  }
}

export {};
