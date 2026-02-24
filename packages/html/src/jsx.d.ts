// Upstream DOM types use "{}" intentionally --
// disable lint for this type
// deno-lint-ignore-file ban-types
import type {
  Cell,
  CELL_LIKE,
  CellLike,
  JSXElement,
  RenderNode,
  Stream,
} from "commontools";

/**
 * Used to represent DOM API's where users can either pass
 * true or false as a boolean or as its equivalent strings.
 */
type Booleanish = boolean | "true" | "false";

// DOM-ish types for the CT runtime.
// The DOM is not directly available within the runtime, but the JSX
// produced must be typed. This defines DOM types like React or Preact,
// with a subset of supported features, and cannot rely on globals
// existing like `HTMLElement` from TypeScript's `dom` lib.
declare namespace CTDOM {
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
  // deno-lint-ignore no-empty-interface
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
   * The **`CSSStyleDeclaration`** interface represents an object that is a CSS declaration block, and exposes style information and various style-related methods and properties.
   *
   * [MDN Reference](https://developer.mozilla.org/docs/Web/API/CSSStyleDeclaration)
   */
  interface CSSStyleDeclaration {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/accent-color) */
    accentColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/align-content) */
    alignContent: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/align-items) */
    alignItems: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/align-self) */
    alignSelf: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/alignment-baseline) */
    alignmentBaseline: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/all) */
    all: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation) */
    animation: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation-composition) */
    animationComposition: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation-delay) */
    animationDelay: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation-direction) */
    animationDirection: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation-duration) */
    animationDuration: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation-fill-mode) */
    animationFillMode: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation-iteration-count) */
    animationIterationCount: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation-name) */
    animationName: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation-play-state) */
    animationPlayState: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation-timing-function) */
    animationTimingFunction: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/appearance) */
    appearance: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/aspect-ratio) */
    aspectRatio: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/backdrop-filter) */
    backdropFilter: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/backface-visibility) */
    backfaceVisibility: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/background) */
    background: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/background-attachment) */
    backgroundAttachment: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/background-blend-mode) */
    backgroundBlendMode: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/background-clip) */
    backgroundClip: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/background-color) */
    backgroundColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/background-image) */
    backgroundImage: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/background-origin) */
    backgroundOrigin: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/background-position) */
    backgroundPosition: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/background-position-x) */
    backgroundPositionX: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/background-position-y) */
    backgroundPositionY: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/background-repeat) */
    backgroundRepeat: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/background-size) */
    backgroundSize: string;
    baselineShift: string;
    baselineSource: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/block-size) */
    blockSize: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border) */
    border: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-block) */
    borderBlock: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-block-color) */
    borderBlockColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-block-end) */
    borderBlockEnd: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-block-end-color) */
    borderBlockEndColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-block-end-style) */
    borderBlockEndStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-block-end-width) */
    borderBlockEndWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-block-start) */
    borderBlockStart: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-block-start-color) */
    borderBlockStartColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-block-start-style) */
    borderBlockStartStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-block-start-width) */
    borderBlockStartWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-block-style) */
    borderBlockStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-block-width) */
    borderBlockWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-bottom) */
    borderBottom: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-bottom-color) */
    borderBottomColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-bottom-left-radius) */
    borderBottomLeftRadius: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-bottom-right-radius) */
    borderBottomRightRadius: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-bottom-style) */
    borderBottomStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-bottom-width) */
    borderBottomWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-collapse) */
    borderCollapse: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-color) */
    borderColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-end-end-radius) */
    borderEndEndRadius: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-end-start-radius) */
    borderEndStartRadius: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-image) */
    borderImage: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-image-outset) */
    borderImageOutset: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-image-repeat) */
    borderImageRepeat: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-image-slice) */
    borderImageSlice: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-image-source) */
    borderImageSource: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-image-width) */
    borderImageWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-inline) */
    borderInline: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-inline-color) */
    borderInlineColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-inline-end) */
    borderInlineEnd: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-inline-end-color) */
    borderInlineEndColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-inline-end-style) */
    borderInlineEndStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-inline-end-width) */
    borderInlineEndWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-inline-start) */
    borderInlineStart: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-inline-start-color) */
    borderInlineStartColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-inline-start-style) */
    borderInlineStartStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-inline-start-width) */
    borderInlineStartWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-inline-style) */
    borderInlineStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-inline-width) */
    borderInlineWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-left) */
    borderLeft: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-left-color) */
    borderLeftColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-left-style) */
    borderLeftStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-left-width) */
    borderLeftWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-radius) */
    borderRadius: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-right) */
    borderRight: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-right-color) */
    borderRightColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-right-style) */
    borderRightStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-right-width) */
    borderRightWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-spacing) */
    borderSpacing: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-start-end-radius) */
    borderStartEndRadius: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-start-start-radius) */
    borderStartStartRadius: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-style) */
    borderStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-top) */
    borderTop: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-top-color) */
    borderTopColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-top-left-radius) */
    borderTopLeftRadius: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-top-right-radius) */
    borderTopRightRadius: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-top-style) */
    borderTopStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-top-width) */
    borderTopWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-width) */
    borderWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/bottom) */
    bottom: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/box-decoration-break) */
    boxDecorationBreak: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/box-shadow) */
    boxShadow: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/box-sizing) */
    boxSizing: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/break-after) */
    breakAfter: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/break-before) */
    breakBefore: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/break-inside) */
    breakInside: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/caption-side) */
    captionSide: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/caret-color) */
    caretColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/clear) */
    clear: string;
    /**
     * @deprecated
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/clip)
     */
    clip: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/clip-path) */
    clipPath: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/clip-rule) */
    clipRule: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/color) */
    color: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/color-interpolation) */
    colorInterpolation: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/color-interpolation-filters) */
    colorInterpolationFilters: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/color-scheme) */
    colorScheme: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/column-count) */
    columnCount: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/column-fill) */
    columnFill: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/column-gap) */
    columnGap: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/column-rule) */
    columnRule: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/column-rule-color) */
    columnRuleColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/column-rule-style) */
    columnRuleStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/column-rule-width) */
    columnRuleWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/column-span) */
    columnSpan: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/column-width) */
    columnWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/columns) */
    columns: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/contain) */
    contain: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/contain-intrinsic-block-size) */
    containIntrinsicBlockSize: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/contain-intrinsic-height) */
    containIntrinsicHeight: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/contain-intrinsic-inline-size) */
    containIntrinsicInlineSize: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/contain-intrinsic-size) */
    containIntrinsicSize: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/contain-intrinsic-width) */
    containIntrinsicWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/container) */
    container: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/container-name) */
    containerName: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/container-type) */
    containerType: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/content) */
    content: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/content-visibility) */
    contentVisibility: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/counter-increment) */
    counterIncrement: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/counter-reset) */
    counterReset: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/counter-set) */
    counterSet: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/CSSStyleDeclaration/cssFloat) */
    cssFloat: string;
    /**
     * The **`cssText`** property of the CSSStyleDeclaration interface returns or sets the text of the element's **inline** style declaration only.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/CSSStyleDeclaration/cssText)
     */
    cssText: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/cursor) */
    cursor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/cx) */
    cx: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/cy) */
    cy: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/d) */
    d: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/direction) */
    direction: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/display) */
    display: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/dominant-baseline) */
    dominantBaseline: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/empty-cells) */
    emptyCells: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/fill) */
    fill: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/fill-opacity) */
    fillOpacity: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/fill-rule) */
    fillRule: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/filter) */
    filter: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/flex) */
    flex: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/flex-basis) */
    flexBasis: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/flex-direction) */
    flexDirection: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/flex-flow) */
    flexFlow: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/flex-grow) */
    flexGrow: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/flex-shrink) */
    flexShrink: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/flex-wrap) */
    flexWrap: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/float) */
    float: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/flood-color) */
    floodColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/flood-opacity) */
    floodOpacity: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font) */
    font: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-family) */
    fontFamily: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-feature-settings) */
    fontFeatureSettings: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-kerning) */
    fontKerning: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-optical-sizing) */
    fontOpticalSizing: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-palette) */
    fontPalette: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-size) */
    fontSize: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-size-adjust) */
    fontSizeAdjust: string;
    /**
     * @deprecated
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-stretch)
     */
    fontStretch: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-style) */
    fontStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-synthesis) */
    fontSynthesis: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-synthesis-small-caps) */
    fontSynthesisSmallCaps: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-synthesis-style) */
    fontSynthesisStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-synthesis-weight) */
    fontSynthesisWeight: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-variant) */
    fontVariant: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-variant-alternates) */
    fontVariantAlternates: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-variant-caps) */
    fontVariantCaps: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-variant-east-asian) */
    fontVariantEastAsian: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-variant-ligatures) */
    fontVariantLigatures: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-variant-numeric) */
    fontVariantNumeric: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-variant-position) */
    fontVariantPosition: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-variation-settings) */
    fontVariationSettings: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/font-weight) */
    fontWeight: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/forced-color-adjust) */
    forcedColorAdjust: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/gap) */
    gap: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/grid) */
    grid: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/grid-area) */
    gridArea: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/grid-auto-columns) */
    gridAutoColumns: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/grid-auto-flow) */
    gridAutoFlow: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/grid-auto-rows) */
    gridAutoRows: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/grid-column) */
    gridColumn: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/grid-column-end) */
    gridColumnEnd: string;
    /** @deprecated This is a legacy alias of `columnGap`. */
    gridColumnGap: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/grid-column-start) */
    gridColumnStart: string;
    /** @deprecated This is a legacy alias of `gap`. */
    gridGap: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/grid-row) */
    gridRow: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/grid-row-end) */
    gridRowEnd: string;
    /** @deprecated This is a legacy alias of `rowGap`. */
    gridRowGap: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/grid-row-start) */
    gridRowStart: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/grid-template) */
    gridTemplate: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/grid-template-areas) */
    gridTemplateAreas: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/grid-template-columns) */
    gridTemplateColumns: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/grid-template-rows) */
    gridTemplateRows: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/height) */
    height: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/hyphenate-character) */
    hyphenateCharacter: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/hyphenate-limit-chars) */
    hyphenateLimitChars: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/hyphens) */
    hyphens: string;
    /**
     * @deprecated
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/image-orientation)
     */
    imageOrientation: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/image-rendering) */
    imageRendering: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/inline-size) */
    inlineSize: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/inset) */
    inset: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/inset-block) */
    insetBlock: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/inset-block-end) */
    insetBlockEnd: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/inset-block-start) */
    insetBlockStart: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/inset-inline) */
    insetInline: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/inset-inline-end) */
    insetInlineEnd: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/inset-inline-start) */
    insetInlineStart: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/isolation) */
    isolation: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/justify-content) */
    justifyContent: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/justify-items) */
    justifyItems: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/justify-self) */
    justifySelf: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/left) */
    left: string;
    /**
     * The read-only property returns an integer that represents the number of style declarations in this CSS declaration block.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/CSSStyleDeclaration/length)
     */
    readonly length: number;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/letter-spacing) */
    letterSpacing: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/lighting-color) */
    lightingColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/line-break) */
    lineBreak: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/line-height) */
    lineHeight: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/list-style) */
    listStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/list-style-image) */
    listStyleImage: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/list-style-position) */
    listStylePosition: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/list-style-type) */
    listStyleType: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/margin) */
    margin: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/margin-block) */
    marginBlock: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/margin-block-end) */
    marginBlockEnd: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/margin-block-start) */
    marginBlockStart: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/margin-bottom) */
    marginBottom: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/margin-inline) */
    marginInline: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/margin-inline-end) */
    marginInlineEnd: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/margin-inline-start) */
    marginInlineStart: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/margin-left) */
    marginLeft: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/margin-right) */
    marginRight: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/margin-top) */
    marginTop: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/marker) */
    marker: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/marker-end) */
    markerEnd: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/marker-mid) */
    markerMid: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/marker-start) */
    markerStart: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask) */
    mask: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-clip) */
    maskClip: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-composite) */
    maskComposite: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-image) */
    maskImage: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-mode) */
    maskMode: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-origin) */
    maskOrigin: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-position) */
    maskPosition: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-repeat) */
    maskRepeat: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-size) */
    maskSize: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-type) */
    maskType: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/math-depth) */
    mathDepth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/math-style) */
    mathStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/max-block-size) */
    maxBlockSize: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/max-height) */
    maxHeight: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/max-inline-size) */
    maxInlineSize: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/max-width) */
    maxWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/min-block-size) */
    minBlockSize: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/min-height) */
    minHeight: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/min-inline-size) */
    minInlineSize: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/min-width) */
    minWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mix-blend-mode) */
    mixBlendMode: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/object-fit) */
    objectFit: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/object-position) */
    objectPosition: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/offset) */
    offset: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/offset-anchor) */
    offsetAnchor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/offset-distance) */
    offsetDistance: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/offset-path) */
    offsetPath: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/offset-position) */
    offsetPosition: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/offset-rotate) */
    offsetRotate: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/opacity) */
    opacity: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/order) */
    order: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/orphans) */
    orphans: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/outline) */
    outline: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/outline-color) */
    outlineColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/outline-offset) */
    outlineOffset: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/outline-style) */
    outlineStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/outline-width) */
    outlineWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/overflow) */
    overflow: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/overflow-anchor) */
    overflowAnchor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/overflow-block) */
    overflowBlock: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/overflow-clip-margin) */
    overflowClipMargin: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/overflow-inline) */
    overflowInline: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/overflow-wrap) */
    overflowWrap: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/overflow-x) */
    overflowX: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/overflow-y) */
    overflowY: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/overscroll-behavior) */
    overscrollBehavior: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/overscroll-behavior-block) */
    overscrollBehaviorBlock: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/overscroll-behavior-inline) */
    overscrollBehaviorInline: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/overscroll-behavior-x) */
    overscrollBehaviorX: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/overscroll-behavior-y) */
    overscrollBehaviorY: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/padding) */
    padding: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/padding-block) */
    paddingBlock: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/padding-block-end) */
    paddingBlockEnd: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/padding-block-start) */
    paddingBlockStart: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/padding-bottom) */
    paddingBottom: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/padding-inline) */
    paddingInline: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/padding-inline-end) */
    paddingInlineEnd: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/padding-inline-start) */
    paddingInlineStart: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/padding-left) */
    paddingLeft: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/padding-right) */
    paddingRight: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/padding-top) */
    paddingTop: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/page) */
    page: string;
    /**
     * @deprecated
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/page-break-after)
     */
    pageBreakAfter: string;
    /**
     * @deprecated
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/page-break-before)
     */
    pageBreakBefore: string;
    /**
     * @deprecated
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/page-break-inside)
     */
    pageBreakInside: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/paint-order) */
    paintOrder: string;
    /**
     * The **CSSStyleDeclaration.parentRule** read-only property returns a CSSRule that is the parent of this style block, e.g., a CSSStyleRule representing the style for a CSS selector.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/CSSStyleDeclaration/parentRule)
     */
    readonly parentRule: CSSRule | null;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/perspective) */
    perspective: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/perspective-origin) */
    perspectiveOrigin: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/place-content) */
    placeContent: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/place-items) */
    placeItems: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/place-self) */
    placeSelf: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/pointer-events) */
    pointerEvents: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/position) */
    position: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/print-color-adjust) */
    printColorAdjust: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/quotes) */
    quotes: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/r) */
    r: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/resize) */
    resize: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/right) */
    right: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/rotate) */
    rotate: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/row-gap) */
    rowGap: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/ruby-align) */
    rubyAlign: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/ruby-position) */
    rubyPosition: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/rx) */
    rx: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/ry) */
    ry: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scale) */
    scale: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-behavior) */
    scrollBehavior: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-margin) */
    scrollMargin: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-margin-block) */
    scrollMarginBlock: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-margin-block-end) */
    scrollMarginBlockEnd: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-margin-block-start) */
    scrollMarginBlockStart: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-margin-bottom) */
    scrollMarginBottom: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-margin-inline) */
    scrollMarginInline: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-margin-inline-end) */
    scrollMarginInlineEnd: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-margin-inline-start) */
    scrollMarginInlineStart: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-margin-left) */
    scrollMarginLeft: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-margin-right) */
    scrollMarginRight: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-margin-top) */
    scrollMarginTop: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-padding) */
    scrollPadding: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-padding-block) */
    scrollPaddingBlock: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-padding-block-end) */
    scrollPaddingBlockEnd: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-padding-block-start) */
    scrollPaddingBlockStart: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-padding-bottom) */
    scrollPaddingBottom: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-padding-inline) */
    scrollPaddingInline: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-padding-inline-end) */
    scrollPaddingInlineEnd: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-padding-inline-start) */
    scrollPaddingInlineStart: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-padding-left) */
    scrollPaddingLeft: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-padding-right) */
    scrollPaddingRight: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-padding-top) */
    scrollPaddingTop: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-snap-align) */
    scrollSnapAlign: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-snap-stop) */
    scrollSnapStop: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scroll-snap-type) */
    scrollSnapType: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scrollbar-color) */
    scrollbarColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scrollbar-gutter) */
    scrollbarGutter: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/scrollbar-width) */
    scrollbarWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/shape-image-threshold) */
    shapeImageThreshold: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/shape-margin) */
    shapeMargin: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/shape-outside) */
    shapeOutside: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/shape-rendering) */
    shapeRendering: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/stop-color) */
    stopColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/stop-opacity) */
    stopOpacity: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/stroke) */
    stroke: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/stroke-dasharray) */
    strokeDasharray: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/stroke-dashoffset) */
    strokeDashoffset: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/stroke-linecap) */
    strokeLinecap: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/stroke-linejoin) */
    strokeLinejoin: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/stroke-miterlimit) */
    strokeMiterlimit: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/stroke-opacity) */
    strokeOpacity: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/stroke-width) */
    strokeWidth: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/tab-size) */
    tabSize: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/table-layout) */
    tableLayout: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-align) */
    textAlign: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-align-last) */
    textAlignLast: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-anchor) */
    textAnchor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-box) */
    textBox: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-box-edge) */
    textBoxEdge: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-box-trim) */
    textBoxTrim: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-combine-upright) */
    textCombineUpright: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-decoration) */
    textDecoration: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-decoration-color) */
    textDecorationColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-decoration-line) */
    textDecorationLine: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-decoration-skip-ink) */
    textDecorationSkipInk: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-decoration-style) */
    textDecorationStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-decoration-thickness) */
    textDecorationThickness: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-emphasis) */
    textEmphasis: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-emphasis-color) */
    textEmphasisColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-emphasis-position) */
    textEmphasisPosition: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-emphasis-style) */
    textEmphasisStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-indent) */
    textIndent: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-orientation) */
    textOrientation: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-overflow) */
    textOverflow: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-rendering) */
    textRendering: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-shadow) */
    textShadow: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-transform) */
    textTransform: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-underline-offset) */
    textUnderlineOffset: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-underline-position) */
    textUnderlinePosition: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-wrap) */
    textWrap: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-wrap-mode) */
    textWrapMode: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-wrap-style) */
    textWrapStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/top) */
    top: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/touch-action) */
    touchAction: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/transform) */
    transform: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/transform-box) */
    transformBox: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/transform-origin) */
    transformOrigin: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/transform-style) */
    transformStyle: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/transition) */
    transition: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/transition-behavior) */
    transitionBehavior: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/transition-delay) */
    transitionDelay: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/transition-duration) */
    transitionDuration: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/transition-property) */
    transitionProperty: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/transition-timing-function) */
    transitionTimingFunction: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/translate) */
    translate: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/unicode-bidi) */
    unicodeBidi: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/user-select) */
    userSelect: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/vector-effect) */
    vectorEffect: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/vertical-align) */
    verticalAlign: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/view-transition-class) */
    viewTransitionClass: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/view-transition-name) */
    viewTransitionName: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/visibility) */
    visibility: string;
    /**
     * @deprecated This is a legacy alias of `alignContent`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/align-content)
     */
    webkitAlignContent: string;
    /**
     * @deprecated This is a legacy alias of `alignItems`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/align-items)
     */
    webkitAlignItems: string;
    /**
     * @deprecated This is a legacy alias of `alignSelf`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/align-self)
     */
    webkitAlignSelf: string;
    /**
     * @deprecated This is a legacy alias of `animation`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation)
     */
    webkitAnimation: string;
    /**
     * @deprecated This is a legacy alias of `animationDelay`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation-delay)
     */
    webkitAnimationDelay: string;
    /**
     * @deprecated This is a legacy alias of `animationDirection`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation-direction)
     */
    webkitAnimationDirection: string;
    /**
     * @deprecated This is a legacy alias of `animationDuration`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation-duration)
     */
    webkitAnimationDuration: string;
    /**
     * @deprecated This is a legacy alias of `animationFillMode`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation-fill-mode)
     */
    webkitAnimationFillMode: string;
    /**
     * @deprecated This is a legacy alias of `animationIterationCount`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation-iteration-count)
     */
    webkitAnimationIterationCount: string;
    /**
     * @deprecated This is a legacy alias of `animationName`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation-name)
     */
    webkitAnimationName: string;
    /**
     * @deprecated This is a legacy alias of `animationPlayState`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation-play-state)
     */
    webkitAnimationPlayState: string;
    /**
     * @deprecated This is a legacy alias of `animationTimingFunction`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/animation-timing-function)
     */
    webkitAnimationTimingFunction: string;
    /**
     * @deprecated This is a legacy alias of `appearance`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/appearance)
     */
    webkitAppearance: string;
    /**
     * @deprecated This is a legacy alias of `backfaceVisibility`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/backface-visibility)
     */
    webkitBackfaceVisibility: string;
    /**
     * @deprecated This is a legacy alias of `backgroundClip`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/background-clip)
     */
    webkitBackgroundClip: string;
    /**
     * @deprecated This is a legacy alias of `backgroundOrigin`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/background-origin)
     */
    webkitBackgroundOrigin: string;
    /**
     * @deprecated This is a legacy alias of `backgroundSize`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/background-size)
     */
    webkitBackgroundSize: string;
    /**
     * @deprecated This is a legacy alias of `borderBottomLeftRadius`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-bottom-left-radius)
     */
    webkitBorderBottomLeftRadius: string;
    /**
     * @deprecated This is a legacy alias of `borderBottomRightRadius`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-bottom-right-radius)
     */
    webkitBorderBottomRightRadius: string;
    /**
     * @deprecated This is a legacy alias of `borderRadius`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-radius)
     */
    webkitBorderRadius: string;
    /**
     * @deprecated This is a legacy alias of `borderTopLeftRadius`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-top-left-radius)
     */
    webkitBorderTopLeftRadius: string;
    /**
     * @deprecated This is a legacy alias of `borderTopRightRadius`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/border-top-right-radius)
     */
    webkitBorderTopRightRadius: string;
    /**
     * @deprecated This is a legacy alias of `boxAlign`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/box-align)
     */
    webkitBoxAlign: string;
    /**
     * @deprecated This is a legacy alias of `boxFlex`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/box-flex)
     */
    webkitBoxFlex: string;
    /**
     * @deprecated This is a legacy alias of `boxOrdinalGroup`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/box-ordinal-group)
     */
    webkitBoxOrdinalGroup: string;
    /**
     * @deprecated This is a legacy alias of `boxOrient`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/box-orient)
     */
    webkitBoxOrient: string;
    /**
     * @deprecated This is a legacy alias of `boxPack`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/box-pack)
     */
    webkitBoxPack: string;
    /**
     * @deprecated This is a legacy alias of `boxShadow`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/box-shadow)
     */
    webkitBoxShadow: string;
    /**
     * @deprecated This is a legacy alias of `boxSizing`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/box-sizing)
     */
    webkitBoxSizing: string;
    /**
     * @deprecated This is a legacy alias of `filter`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/filter)
     */
    webkitFilter: string;
    /**
     * @deprecated This is a legacy alias of `flex`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/flex)
     */
    webkitFlex: string;
    /**
     * @deprecated This is a legacy alias of `flexBasis`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/flex-basis)
     */
    webkitFlexBasis: string;
    /**
     * @deprecated This is a legacy alias of `flexDirection`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/flex-direction)
     */
    webkitFlexDirection: string;
    /**
     * @deprecated This is a legacy alias of `flexFlow`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/flex-flow)
     */
    webkitFlexFlow: string;
    /**
     * @deprecated This is a legacy alias of `flexGrow`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/flex-grow)
     */
    webkitFlexGrow: string;
    /**
     * @deprecated This is a legacy alias of `flexShrink`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/flex-shrink)
     */
    webkitFlexShrink: string;
    /**
     * @deprecated This is a legacy alias of `flexWrap`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/flex-wrap)
     */
    webkitFlexWrap: string;
    /**
     * @deprecated This is a legacy alias of `justifyContent`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/justify-content)
     */
    webkitJustifyContent: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/line-clamp) */
    webkitLineClamp: string;
    /**
     * @deprecated This is a legacy alias of `mask`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask)
     */
    webkitMask: string;
    /**
     * @deprecated This is a legacy alias of `maskBorder`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-border)
     */
    webkitMaskBoxImage: string;
    /**
     * @deprecated This is a legacy alias of `maskBorderOutset`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-border-outset)
     */
    webkitMaskBoxImageOutset: string;
    /**
     * @deprecated This is a legacy alias of `maskBorderRepeat`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-border-repeat)
     */
    webkitMaskBoxImageRepeat: string;
    /**
     * @deprecated This is a legacy alias of `maskBorderSlice`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-border-slice)
     */
    webkitMaskBoxImageSlice: string;
    /**
     * @deprecated This is a legacy alias of `maskBorderSource`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-border-source)
     */
    webkitMaskBoxImageSource: string;
    /**
     * @deprecated This is a legacy alias of `maskBorderWidth`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-border-width)
     */
    webkitMaskBoxImageWidth: string;
    /**
     * @deprecated This is a legacy alias of `maskClip`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-clip)
     */
    webkitMaskClip: string;
    /**
     * @deprecated This is a legacy alias of `maskComposite`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-composite)
     */
    webkitMaskComposite: string;
    /**
     * @deprecated This is a legacy alias of `maskImage`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-image)
     */
    webkitMaskImage: string;
    /**
     * @deprecated This is a legacy alias of `maskOrigin`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-origin)
     */
    webkitMaskOrigin: string;
    /**
     * @deprecated This is a legacy alias of `maskPosition`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-position)
     */
    webkitMaskPosition: string;
    /**
     * @deprecated This is a legacy alias of `maskRepeat`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-repeat)
     */
    webkitMaskRepeat: string;
    /**
     * @deprecated This is a legacy alias of `maskSize`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/mask-size)
     */
    webkitMaskSize: string;
    /**
     * @deprecated This is a legacy alias of `order`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/order)
     */
    webkitOrder: string;
    /**
     * @deprecated This is a legacy alias of `perspective`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/perspective)
     */
    webkitPerspective: string;
    /**
     * @deprecated This is a legacy alias of `perspectiveOrigin`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/perspective-origin)
     */
    webkitPerspectiveOrigin: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/-webkit-text-fill-color) */
    webkitTextFillColor: string;
    /**
     * @deprecated This is a legacy alias of `textSizeAdjust`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/text-size-adjust)
     */
    webkitTextSizeAdjust: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/-webkit-text-stroke) */
    webkitTextStroke: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/-webkit-text-stroke-color) */
    webkitTextStrokeColor: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/-webkit-text-stroke-width) */
    webkitTextStrokeWidth: string;
    /**
     * @deprecated This is a legacy alias of `transform`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/transform)
     */
    webkitTransform: string;
    /**
     * @deprecated This is a legacy alias of `transformOrigin`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/transform-origin)
     */
    webkitTransformOrigin: string;
    /**
     * @deprecated This is a legacy alias of `transformStyle`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/transform-style)
     */
    webkitTransformStyle: string;
    /**
     * @deprecated This is a legacy alias of `transition`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/transition)
     */
    webkitTransition: string;
    /**
     * @deprecated This is a legacy alias of `transitionDelay`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/transition-delay)
     */
    webkitTransitionDelay: string;
    /**
     * @deprecated This is a legacy alias of `transitionDuration`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/transition-duration)
     */
    webkitTransitionDuration: string;
    /**
     * @deprecated This is a legacy alias of `transitionProperty`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/transition-property)
     */
    webkitTransitionProperty: string;
    /**
     * @deprecated This is a legacy alias of `transitionTimingFunction`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/transition-timing-function)
     */
    webkitTransitionTimingFunction: string;
    /**
     * @deprecated This is a legacy alias of `userSelect`.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/user-select)
     */
    webkitUserSelect: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/white-space) */
    whiteSpace: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/white-space-collapse) */
    whiteSpaceCollapse: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/widows) */
    widows: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/width) */
    width: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/will-change) */
    willChange: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/word-break) */
    wordBreak: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/word-spacing) */
    wordSpacing: string;
    /**
     * @deprecated
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/overflow-wrap)
     */
    wordWrap: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/writing-mode) */
    writingMode: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/x) */
    x: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/y) */
    y: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/z-index) */
    zIndex: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/zoom) */
    zoom: string;
  }

  export type DOMCSSProperties = {
    [key in keyof CSSStyleDeclaration]?: string | number | null | undefined;
  };

  /**
   * Represents the built-in attributes available to class components.
   */
  // deno-lint-ignore no-empty-interface
  interface ClassAttributes<T> {}

  export interface HTMLProps<T>
    extends AllHTMLAttributes<T>, ClassAttributes<T> {
  }

  export type DetailedHTMLProps<E extends HTMLAttributes<T>, T> =
    & ClassAttributes<T>
    & {
      [K in keyof E]: E[K] extends { [CELL_LIKE]: unknown } ? E[K]
        : (E[K] | CellLike<E[K]>);
    };

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
    "onClick"?: EventHandler<unknown>;
    "onChange"?: EventHandler<unknown>;
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
    hidden?: Booleanish; // CT addition to be compatible with our component usage of `hidden`
    id?: string | undefined;
    lang?: string | undefined;
    nonce?: string | undefined;
    slot?: string | undefined;
    spellCheck?: Booleanish | undefined;
    style?: string | DOMCSSProperties | undefined;
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

  // deno-lint-ignore no-empty-interface
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

type CTEvent<T> = {
  detail: T;
};

type EventHandler<T> =
  | CellLike<CTEvent<T> | T>
  | ((event: CTEvent<T>) => void)
  | (() => void)
  | Stream<T>
  | Stream<void>;

// `Charm` is not a pattern type.
type Charm = any;

type OutlinerNode = {
  body: string;
  children: OutlinerNode[];
  attachments: Charm[];
};

interface CTOutlinerElement extends CTHTMLElement {}
interface CTCellLinkElement extends CTHTMLElement {}
interface CTSpaceLinkElement extends CTHTMLElement {}
interface CTLoaderElement extends CTHTMLElement {}
interface CTInputElement extends CTHTMLElement {}
interface CTTextAreaElement extends CTHTMLElement {}
interface CTFileInputElement extends CTHTMLElement {}
interface CTImageInputElement extends CTHTMLElement {}
interface CTInputLegacyElement extends CTHTMLElement {}
interface CTCheckboxElement extends CTHTMLElement {}
interface CTAutocompleteElement extends CTHTMLElement {}
interface CTSelectElement extends CTHTMLElement {}
interface CTRadioGroupElement extends CTHTMLElement {}
interface CTPickerElement extends CTHTMLElement {}
interface CTToolsChipElement extends CTHTMLElement {}
interface CTHeadingElement extends CTHTMLElement {}
interface CTCollapsibleElement extends CTHTMLElement {}
interface CTThemeElement extends CTHTMLElement {}
interface CTCodeEditorElement extends CTHTMLElement {}
interface CTCodeEditorLegacyElement extends CTHTMLElement {}
interface CTScreenElement extends CTHTMLElement {}
interface CTAutostartElement extends CTHTMLElement {}
interface CTAutoLayoutElement extends CTHTMLElement {}
interface CTButtonElement extends CTHTMLElement {}
interface CTCopyButtonElement extends CTHTMLElement {}
interface CTFileDownloadElement extends CTHTMLElement {}
interface CTIFrameElement extends CTHTMLElement {}
interface CTHStackElement extends CTHTMLElement {}
interface CTFabElement extends CTHTMLElement {}
interface CTModalElement extends CTHTMLElement {}
interface CTModalProviderElement extends CTHTMLElement {}
interface CTChevronButtonElement extends CTHTMLElement {}
interface CTCardElement extends CTHTMLElement {}
interface CTQuestionElement extends CTHTMLElement {}
interface CTAlertElement extends CTHTMLElement {}
interface CTVStackElement extends CTHTMLElement {}
interface CTMessageInputElement extends CTHTMLElement {}
interface CTToolbarElement extends CTHTMLElement {}
interface CTKbdElement extends CTHTMLElement {}
interface CTKeybindElement extends CTHTMLElement {}
interface CTRenderElement extends CTHTMLElement {}
interface CTCellContextElement extends CTHTMLElement {}
interface CTDragSourceElement extends CTHTMLElement {}
interface CTDropZoneElement extends CTHTMLElement {}
interface CTChatMessageElement extends CTHTMLElement {}
interface CTMarkdownElement extends CTHTMLElement {}
interface CTVScrollElement extends CTHTMLElement {}
interface CTSendMessageElement extends CTHTMLElement {}
interface CTTextElement extends CTHTMLElement {}
interface CTTableElement extends CTHTMLElement {}
interface CTTagsElement extends CTHTMLElement {}
interface CTPromptInputElement extends CTHTMLElement {}
interface CTChatElement extends CTHTMLElement {}
interface CTMessageBeadsElement extends CTHTMLElement {}
interface CTAttachmentsBarElement extends CTHTMLElement {}
interface CTCTCollapsibleElement extends CTHTMLElement {}
interface CTFragmentElement extends CTHTMLElement {}
interface CTUpdaterElement extends CTHTMLElement {}
interface CTGoogleOAuthElement extends CTHTMLElement {}
interface CTCanvasElement extends CTHTMLElement {}
interface CTDraggableElement extends CTHTMLElement {}
interface CTPlaidLinkElement extends CTHTMLElement {}
interface CTPieceElement extends CTHTMLElement {}
interface CTIFrameElement extends CTHTMLElement {}
interface CTVoiceInputElement extends CTHTMLElement {}
interface CTAudioVisualizerElement extends CTHTMLElement {}
interface CTLocationElement extends CTHTMLElement {}

// Chart components
interface CTChartElement extends CTHTMLElement {}
interface CTLineMarkElement extends CTHTMLElement {}
interface CTAreaMarkElement extends CTHTMLElement {}
interface CTBarMarkElement extends CTHTMLElement {}
interface CTDotMarkElement extends CTHTMLElement {}

// Tab components
interface CTTabsElement extends CTHTMLElement {}
interface CTTabElement extends CTHTMLElement {}
interface CTTabListElement extends CTHTMLElement {}
interface CTTabPanelElement extends CTHTMLElement {}

// Accordion components
interface CTAccordionElement extends CTHTMLElement {}
interface CTAccordionItemElement extends CTHTMLElement {}

// Form components
interface CTFormElement extends CTHTMLElement {}
interface CTSliderElement extends CTHTMLElement {}
interface CTSwitchElement extends CTHTMLElement {}
interface CTToggleElement extends CTHTMLElement {}
interface CTToggleGroupElement extends CTHTMLElement {}
interface CTRadioElement extends CTHTMLElement {}
interface CTInputOtpElement extends CTHTMLElement {}
interface CTLabelElement extends CTHTMLElement {}

// Display components
interface CTBadgeElement extends CTHTMLElement {}
interface CTChipElement extends CTHTMLElement {}
interface CTProgressElement extends CTHTMLElement {}
interface CTSkeletonElement extends CTHTMLElement {}
interface CTSeparatorElement extends CTHTMLElement {}
interface CTTileElement extends CTHTMLElement {}

// Layout components
interface CTGridElement extends CTHTMLElement {}
interface CTHGroupElement extends CTHTMLElement {}
interface CTVGroupElement extends CTHTMLElement {}
interface CTAspectRatioElement extends CTHTMLElement {}

// Resizable components
interface CTResizablePanelElement extends CTHTMLElement {}
interface CTResizablePanelGroupElement extends CTHTMLElement {}
interface CTResizableHandleElement extends CTHTMLElement {}

// Other components
interface CTScrollAreaElement extends CTHTMLElement {}
interface CTToolCallElement extends CTHTMLElement {}

interface CTDraggableAttributes<T> extends CTHTMLAttributes<T> {
  "key"?: number;
  "x"?: EventHandler<any>;
  "y"?: EventHandler<any>;
  "hidden"?: Booleanish;
  "onpositionchange"?: EventHandler<any>;
}

interface CTCanvasAttributes<T> extends CTHTMLAttributes<T> {
  "width"?: string | number;
  "height"?: string | number;
  "onct-canvas-click"?: EventHandler<any>;
}

interface CTPlaidLinkAttributes<T> extends CTHTMLAttributes<T> {
  "$auth"?: any;
  "products"?: string[];
}

interface CTGoogleOAuthAttributes<T> extends CTHTMLAttributes<T> {
  "$auth"?: any;
  "scopes"?: string[];
}

interface CTUpdaterAttributes<T> extends CTHTMLAttributes<T> {
  "integration"?: string;
  "$state"?: CellLike<any>;
}

interface CTPieceAttributes<T> extends CTHTMLAttributes<T> {
  "piece-id"?: string;
  "space-name"?: string;
}

interface CTVoiceInputAttributes<T> extends CTHTMLAttributes<T> {
  "$transcription"?: CellLike<any>;
  "recordingMode"?: "hold" | "toggle";
  "autoTranscribe"?: boolean;
  "maxDuration"?: number;
  "showWaveform"?: boolean;
  "disabled"?: boolean;
  "barCount"?: number;
  "barWidth"?: number;
  "barGap"?: number;
  "minHeight"?: number;
  "maxHeight"?: number;
  "visualizerColor"?: string;
  "smoothing"?: number;
  "onct-transcription-complete"?: EventHandler<any>;
  "onct-transcription-error"?: EventHandler<any>;
  "onct-recording-start"?: EventHandler<any>;
  "onct-recording-stop"?: EventHandler<any>;
  "onct-error"?: EventHandler<any>;
  "onct-change"?: EventHandler<any>;
}

interface CTAudioVisualizerAttributes<T> extends CTHTMLAttributes<T> {
  "barCount"?: number;
  "barWidth"?: number;
  "barGap"?: number;
  "minHeight"?: number;
  "maxHeight"?: number;
  "color"?: string;
  "smoothing"?: number;
}

// Chart component attributes
interface CTChartAttributes<T> extends CTHTMLAttributes<T> {
  "height"?: number;
  "marks"?: any[] | CellLike<any[]>;
  "$marks"?: any[] | CellLike<any[]>;
  "xAxis"?: boolean | {
    label?: string;
    tickFormat?: string | ((value: unknown) => string);
    grid?: boolean;
    tickCount?: number;
  };
  "yAxis"?: boolean | {
    label?: string;
    tickFormat?: string | ((value: unknown) => string);
    grid?: boolean;
    tickCount?: number;
  };
  "xType"?: "linear" | "time" | "band";
  "yType"?: "linear" | "log";
  "xDomain"?: [unknown, unknown];
  "yDomain"?: [number, number];
  "padding"?: number | [number, number, number, number];
  "crosshair"?: boolean;
  "onct-hover"?: EventHandler<any>;
  "onct-click"?: EventHandler<any>;
  "onct-leave"?: EventHandler<any>;
}

interface CTLineMarkAttributes<T> extends CTHTMLAttributes<T> {
  "data"?: any[] | CellLike<any[]>;
  "$data"?: any[] | CellLike<any[]>;
  "x"?: string;
  "y"?: string;
  "color"?: string;
  "strokeWidth"?: number;
  "curve"?: "linear" | "step" | "monotone" | "natural";
  "label"?: string;
}

interface CTAreaMarkAttributes<T> extends CTHTMLAttributes<T> {
  "data"?: any[] | CellLike<any[]>;
  "$data"?: any[] | CellLike<any[]>;
  "x"?: string;
  "y"?: string;
  "color"?: string;
  "strokeWidth"?: number;
  "curve"?: "linear" | "step" | "monotone" | "natural";
  "opacity"?: number;
  "y2"?: number;
  "label"?: string;
}

interface CTBarMarkAttributes<T> extends CTHTMLAttributes<T> {
  "data"?: any[] | CellLike<any[]>;
  "$data"?: any[] | CellLike<any[]>;
  "x"?: string;
  "y"?: string;
  "color"?: string;
  "opacity"?: number;
  "barPadding"?: number;
  "label"?: string;
}

interface CTDotMarkAttributes<T> extends CTHTMLAttributes<T> {
  "data"?: any[] | CellLike<any[]>;
  "$data"?: any[] | CellLike<any[]>;
  "x"?: string;
  "y"?: string;
  "color"?: string;
  "radius"?: number;
  "label"?: string;
}

interface CTLocationAttributes<T> extends CTHTMLAttributes<T> {
  "$location"?: CellLike<any>;
  "enableHighAccuracy"?: boolean;
  "timeout"?: number;
  "maximumAge"?: number;
  "continuous"?: boolean;
  "disabled"?: boolean;
  "onct-location-start"?: EventHandler<any>;
  "onct-location-update"?: EventHandler<any>;
  "onct-location-error"?: EventHandler<any>;
  "onct-change"?: EventHandler<any>;
}

interface CTChatAttributes<T> extends CTHTMLAttributes<T> {
  "$messages"?: CellLike<any>;
  "pending"?: boolean;
  "theme"?: CTThemeInput;
  "tools"?: any;
}

interface CTMessageBeadsAttributes<T> extends CTHTMLAttributes<T> {
  "$messages"?: CellLike<any>;
  "pending"?: boolean;
  "label"?: string;
  "onct-refine"?: EventHandler<any>;
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
  "voice"?: boolean;
}

interface CTAttachmentsBarAttributes<T> extends CTHTMLAttributes<T> {
  "removable"?: boolean;
  "pinnedCells"?: any;
}

interface CTTagsAttributes<T> extends CTHTMLAttributes<T> {
  "tags"?: string[];
  "onct-change"?: EventHandler<any>;
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
  "value"?: any;
  "placeholder"?: string;
  "appearance"?: "rounded";
  "onct-send"?: EventHandler<{ message: string }>;
  "inline"?: Booleanish;
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
  "oncharm-link-click"?: EventHandler<{ charm: Cell<Charm> }>;
}

interface CTCellLinkAttributes<T> extends CTHTMLAttributes<T> {
  "link"?: string;
  "$cell": CellLike<any>;
}

interface CTSpaceLinkAttributes<T> extends CTHTMLAttributes<T> {
  "spaceName"?: string;
  "spaceDid"?: string;
  "label"?: string;
}

interface CTChatMessageAttributes<T> extends CTHTMLAttributes<T> {
  "role"?: "user" | "assistant";
  "content"?: string;
  "avatar"?: string;
  "name"?: string;
  "compact"?: boolean;
  "pending"?: boolean;
}

interface CTMarkdownAttributes<T> extends CTHTMLAttributes<T> {
  "content"?: string;
  "$content"?: CellLike<string>;
  "variant"?: "default" | "inverse";
  "streaming"?: boolean;
  "compact"?: boolean;
}

interface CTAlertAttributes<T> extends CTHTMLAttributes<T> {
  "variant"?: "default" | "destructive" | "warning" | "success" | "info";
  "dismissible"?: boolean;
  "onct-dismiss"?: EventHandler<{}>;
}

interface CTCardAttributes<T> extends CTHTMLAttributes<T> {
  "clickable"?: boolean;
}

interface CTQuestionAttributes<T> extends CTHTMLAttributes<T> {
  "question"?: CellLike<string>;
  "options"?: CellLike<string[]>;
  "onct-answer"?: EventHandler<{ answer: string }>;
}

interface CTButtonAttributes<T> extends CTHTMLAttributes<T> {
  "variant"?:
    | "default"
    | "primary"
    | "destructive"
    | "outline"
    | "secondary"
    | "ghost"
    | "link"
    | "pill";
  "size"?: "default" | "sm" | "lg" | "icon";
  "disabled"?: boolean;
  "outline"?: boolean;
  "type"?: "button" | "submit" | "reset";
}

interface CTCopyButtonAttributes<T> extends CTHTMLAttributes<T> {
  "text": string | Record<string, string>;
  "variant"?:
    | "primary"
    | "secondary"
    | "destructive"
    | "outline"
    | "ghost"
    | "link"
    | "pill";
  "size"?: "default" | "sm" | "lg" | "icon" | "md";
  "disabled"?: boolean;
  "feedback-duration"?: number;
  "icon-only"?: boolean;
}

interface CTFileDownloadAttributes<T> extends CTHTMLAttributes<T> {
  "$data"?: CellLike<string>;
  "data"?: string;
  "$filename"?: CellLike<string>;
  "filename"?: string;
  "mime-type"?: string;
  "mimeType"?: string;
  "base64"?: boolean;
  "variant"?:
    | "primary"
    | "secondary"
    | "destructive"
    | "outline"
    | "ghost"
    | "link"
    | "pill";
  "size"?: "default" | "sm" | "lg" | "icon" | "md";
  "disabled"?: boolean;
  "feedback-duration"?: number;
  "feedbackDuration"?: number;
  "icon-only"?: boolean;
  "iconOnly"?: boolean;
  "allow-autosave"?: boolean;
  "allowAutosave"?: boolean;
}

interface CTIframeAttributes<T> extends CTHTMLAttributes<T> {
  "src": string;
  "$context": CellLike<any>;
}

interface CTRenderAttributes<T> extends CTHTMLAttributes<T> {
  "$cell": CellLike<any>;
  "variant"?:
    | "default"
    | "preview"
    | "thumbnail"
    | "sidebar"
    | "fab"
    | "settings"
    | "embedded";
}

interface CTCellContextAttributes<T> extends CTHTMLAttributes<T> {
  "$cell": CellLike<any>;
  "label"?: string;
  "inline"?: boolean;
}

interface CTDragSourceAttributes<T> extends CTHTMLAttributes<T> {
  "$cell": CellLike<any>;
  "type"?: string;
  "disabled"?: boolean;
  "onct-drag-start"?: EventHandler<{ cell: any }>;
  "onct-drag-end"?: EventHandler<{ cell: any }>;
}

interface CTDropZoneAttributes<T> extends CTHTMLAttributes<T> {
  "accept"?: string;
  "onct-drag-enter"?: EventHandler<{ sourceCell: any; type?: string }>;
  "onct-drag-leave"?: EventHandler<{}>;
  "onct-drop"?: EventHandler<
    {
      sourceCell: any;
      sourceCellRef?: { id: string; space: string; path: string[] };
      type?: string;
    }
  >;
}

interface CTLoaderAttributes<T> extends CTHTMLAttributes<T> {
  "size"?: "sm" | "md" | "lg";
  "show-elapsed"?: boolean;
  "show-stop"?: boolean;
  /** Fired when stop button is clicked */
  "onct-stop"?: EventHandler<{}>;
}

interface CTFabAttributes<T> extends CTHTMLAttributes<T> {
  "expanded"?: boolean;
  "variant"?: "default" | "primary";
  "position"?:
    | "bottom-right"
    | "bottom-left"
    | "top-right"
    | "top-left"
    | "bottom-center";
  "pending"?: boolean;
  "pinCount"?: number;
  "$messages"?: CellLike<any[]>;
  "$previewMessage"?: CellLike<string | null>;
  "placeholder"?: string;
}

interface CTModalAttributes<T> extends CTHTMLAttributes<T> {
  "$open"?: CellLike<boolean> | boolean;
  "dismissable"?: boolean;
  "size"?: "sm" | "md" | "lg" | "full";
  "prevent-scroll"?: boolean;
  "label"?: string;
  "onct-modal-open"?: EventHandler<void>;
  "onct-modal-close"?: EventHandler<{ reason: string }>;
  "onct-modal-opened"?: EventHandler<void>;
  "onct-modal-closed"?: EventHandler<void>;
}

interface CTModalProviderAttributes<T> extends CTHTMLAttributes<T> {}

interface CTChevronButtonAttributes<T> extends CTHTMLAttributes<T> {
  "expanded"?: boolean;
  "loading"?: boolean;
}

interface CTInputAttributes<T> extends CTHTMLAttributes<T> {
  "$value"?: CellLike<string | number | null | undefined>;
  "customStyle"?: string; // bf: I think this is going to go away one day soon
  "type"?:
    | "text"
    | "password"
    | "email"
    | "number"
    | "tel"
    | "url"
    | "search"
    | "date"
    | "time"
    | "datetime-local"
    | "month"
    | "week"
    | "color"
    | "file"
    | "range"
    | "hidden";
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
  "timingDelay"?: number | string;
  "onct-change"?: any;
  "onct-focus"?: any;
  "onct-blur"?: any;
  "onct-keydown"?: any;
  "onct-submit"?: any;
  "onct-invalid"?: any;
}

interface CTTextAreaAttributes<T> extends CTHTMLAttributes<T> {
  "$value"?: CellLike<string | undefined>;
  "value"?: CellLike<string> | string;
  "placeholder"?: string;
  "disabled"?: boolean;
  "readonly"?: boolean;
  "error"?: boolean;
  "name"?: string;
  "required"?: boolean;
  "autofocus"?: boolean;
  "rows"?: number;
  "cols"?: number;
  "maxlength"?: string;
  "minlength"?: string;
  "wrap"?: string;
  "spellcheck"?: boolean;
  "autocomplete"?: string;
  "resize"?: string;
  "auto-resize"?: boolean;
  "timing-strategy"?: "immediate" | "debounce" | "throttle" | "blur";
  "timing-delay"?: number;
  "onct-input"?: EventHandler<
    { value: string; oldValue: string; name: string }
  >;
  "onct-change"?: EventHandler<
    { value: string; oldValue: string; name: string }
  >;
  "onct-focus"?: EventHandler<{ value: string; name: string }>;
  "onct-blur"?: EventHandler<{ value: string; name: string }>;
  "onct-keydown"?: EventHandler<{
    key: string;
    value: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    name: string;
  }>;
  "onct-submit"?: EventHandler<{ value: string; name: string }>;
}

interface CTInputLegacyAttributes<T> extends CTHTMLAttributes<T> {
  "value"?: CellLike<string>;
  "placeholder"?: string;
  "appearance"?: string;
  "customStyle"?: string;
}

interface CTFileInputAttributes<T> extends CTHTMLAttributes<T> {
  "multiple"?: boolean;
  "maxFiles"?: number;
  "accept"?: string;
  "buttonText"?: string;
  "variant"?:
    | "default"
    | "primary"
    | "secondary"
    | "outline"
    | "ghost"
    | "link"
    | "destructive";
  "size"?: "default" | "sm" | "lg" | "icon";
  "showPreview"?: boolean;
  "previewSize"?: "sm" | "md" | "lg";
  "removable"?: boolean;
  "disabled"?: boolean;
  "maxSizeBytes"?: number;
  "files"?: any[]; // FileData[]
  "$files"?: any; // CellLike<FileData[]>
  "onct-change"?: EventHandler<any>;
  "onct-remove"?: EventHandler<any>;
  "onct-error"?: EventHandler<any>;
}

interface CTImageInputAttributes<T> extends CTHTMLAttributes<T> {
  "multiple"?: boolean;
  "maxImages"?: number;
  "maxSizeBytes"?: number;
  "capture"?: "user" | "environment" | false;
  "buttonText"?: string;
  "variant"?:
    | "default"
    | "primary"
    | "secondary"
    | "outline"
    | "ghost"
    | "link"
    | "destructive";
  "size"?: "default" | "sm" | "lg" | "icon";
  "showPreview"?: boolean;
  "previewSize"?: "sm" | "md" | "lg";
  "removable"?: boolean;
  "disabled"?: boolean;
  "images"?: any[]; // ImageData[]
  "$images"?: any; // CellLike<ImageData[]>
  "onct-change"?: EventHandler<any>;
  "onct-remove"?: EventHandler<any>;
  "onct-error"?: EventHandler<any>;
}

interface CTCheckboxAttributes<T> extends CTHTMLAttributes<T> {
  "$checked"?: CellLike<boolean>;
  "checked"?: boolean;
  "disabled"?: boolean;
  "indeterminate"?: boolean;
  "name"?: string;
  "value"?: string;
  "onct-change"?: EventHandler<any>;
}

interface CTAutocompleteAttributes<T> extends CTHTMLAttributes<T> {
  "$value"?: CellLike<string | string[]>;
  "items": {
    value: string;
    label?: string;
    group?: string;
    searchAliases?: string[];
  }[];
  "placeholder"?: string;
  "maxVisible"?: number;
  "allowCustom"?: boolean;
  "multiple"?: boolean;
  "disabled"?: boolean;
  "onct-change"?: EventHandler<
    { value: string | string[]; oldValue: string | string[] }
  >;
  "onct-select"?: EventHandler<
    { value: string; label: string; group?: string; isCustom: boolean }
  >;
  "onct-open"?: EventHandler<any>;
  "onct-close"?: EventHandler<any>;
}

interface CTSelectAttributes<T> extends CTHTMLAttributes<T> {
  "$value": CellLike<any | any[]>;
  "items": { label: string; value: any }[];
  "multiple"?: boolean;
  "disabled"?: boolean;
  "required"?: boolean;
  "size"?: number;
  "name"?: string;
  "placeholder"?: string;
  "onct-change"?: EventHandler<
    { items: { label: string; value: any }[]; value: any | any[] }
  >;
}

interface CTRadioGroupAttributes<T> extends CTHTMLAttributes<T> {
  "$value"?: CellLike<any>;
  "value"?: any;
  "items"?: { label: string; value: any; disabled?: boolean }[];
  "name"?: string;
  "disabled"?: boolean;
  "orientation"?: "vertical" | "horizontal";
  "onct-change"?: EventHandler<
    { items: { label: string; value: any }[]; value: any; oldValue: any }
  >;
}

interface CTPickerAttributes<T> extends CTHTMLAttributes<T> {
  "$selectedIndex"?: CellLike<number>;
  "$items": CellLike<any[]>;
  "disabled"?: boolean;
  "min-height"?: string;
  "onct-change"?: EventHandler<
    { value: any; oldValue: any; items: any[] }
  >;
  "onct-focus"?: EventHandler<any>;
  "onct-blur"?: EventHandler<any>;
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
  "$tools"?:
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
interface CTCodeEditorLegacyAttributes<T> extends CTHTMLAttributes<T> {
  "source"?: string;
  "language"?:
    | "text/css"
    | "text/html"
    | "text/javascript"
    | "text/x.jsx"
    | "text/x.typescript"
    | "application/json"
    | "text/markdown";
  "onChange"?: any;
  "errors"?: any[];
}

interface CTCodeEditorAttributes<T> extends CTHTMLAttributes<T> {
  "$value"?: CellLike<string>;
  "value"?: string;
  "language"?:
    | "text/css"
    | "text/html"
    | "text/javascript"
    | "text/x.jsx"
    | "text/x.typescript"
    | "application/json"
    | "text/markdown";
  "disabled"?: boolean;
  "readonly"?: boolean;
  "placeholder"?: string;
  "timingStrategy"?: string;
  "timingDelay"?: number;
  "$mentionable"?: CellLike<Charm[]> | CellLike<Charm[] | undefined>;
  "$mentioned"?: CellLike<Charm[]> | CellLike<Charm[] | undefined>;
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

interface CTAutostartAttributes<T> extends CTHTMLAttributes<T> {
  "onstart"?: any;
}

interface CTAutoLayoutAttributes<T> extends CTHTMLAttributes<T> {
  "tabNames"?: string[];
  "leftOpen"?: boolean;
  "rightOpen"?: boolean;
}

// Tab component attributes
interface CTTabsAttributes<T> extends CTHTMLAttributes<T> {
  "$value"?: CellLike<string>; // Bidirectional cell binding
  "value"?: string; // Plain string value (use $value for cells)
  "orientation"?:
    | "horizontal"
    | "vertical"
    | CellLike<"horizontal" | "vertical">;
  "onct-change"?: EventHandler<{ value: string; oldValue: string }>;
}

interface CTTabAttributes<T> extends CTHTMLAttributes<T> {
  "value"?: string; // Tab identifier (plain string, no cell binding needed)
  "disabled"?: boolean | CellLike<boolean>;
  "selected"?: boolean | CellLike<boolean>;
}

interface CTTabListAttributes<T> extends CTHTMLAttributes<T> {
  "orientation"?:
    | "horizontal"
    | "vertical"
    | CellLike<"horizontal" | "vertical">;
}

interface CTTabPanelAttributes<T> extends CTHTMLAttributes<T> {
  "value"?: string; // Panel identifier (plain string, no cell binding needed)
}

// Accordion component attributes
interface CTAccordionAttributes<T> extends CTHTMLAttributes<T> {
  "type"?: "single" | "multiple" | CellLike<"single" | "multiple">;
  "value"?: string | string[] | CellLike<string | string[]>;
  "collapsible"?: boolean | CellLike<boolean>;
  "onct-change"?: EventHandler<{ value: string | string[] }>;
}

interface CTAccordionItemAttributes<T> extends CTHTMLAttributes<T> {
  "value"?: string | CellLike<string>;
  "disabled"?: boolean | CellLike<boolean>;
  "expanded"?: boolean | CellLike<boolean>;
}

// Form component attributes
interface CTFormAttributes<T> extends CTHTMLAttributes<T> {
  "method"?: "GET" | "POST" | CellLike<"GET" | "POST">;
  "action"?: string | CellLike<string>;
  "onct-submit"?: EventHandler<any>;
}

interface CTSliderAttributes<T> extends CTHTMLAttributes<T> {
  "value"?: number | CellLike<number>;
  "$value"?: CellLike<number>;
  "min"?: number | CellLike<number>;
  "max"?: number | CellLike<number>;
  "step"?: number | CellLike<number>;
  "disabled"?: boolean | CellLike<boolean>;
  "orientation"?:
    | "horizontal"
    | "vertical"
    | CellLike<"horizontal" | "vertical">;
  "onct-change"?: EventHandler<{ value: number }>;
}

interface CTSwitchAttributes<T> extends CTHTMLAttributes<T> {
  "checked"?: boolean | CellLike<boolean>;
  "$checked"?: CellLike<boolean>;
  "disabled"?: boolean | CellLike<boolean>;
  "name"?: string | CellLike<string>;
  "value"?: string | CellLike<string>;
  "onct-change"?: EventHandler<{ checked: boolean }>;
}

interface CTToggleAttributes<T> extends CTHTMLAttributes<T> {
  "pressed"?: boolean | CellLike<boolean>;
  "$pressed"?: CellLike<boolean>;
  "disabled"?: boolean | CellLike<boolean>;
  "variant"?: "default" | "outline" | CellLike<"default" | "outline">;
  "size"?: "default" | "sm" | "lg" | CellLike<"default" | "sm" | "lg">;
  "onct-change"?: EventHandler<{ pressed: boolean }>;
}

interface CTToggleGroupAttributes<T> extends CTHTMLAttributes<T> {
  "type"?: "single" | "multiple" | CellLike<"single" | "multiple">;
  "value"?: string | string[] | CellLike<string | string[]>;
  "$value"?: CellLike<string | string[]>;
  "disabled"?: boolean | CellLike<boolean>;
  "onct-change"?: EventHandler<{ value: string | string[] }>;
}

interface CTRadioAttributes<T> extends CTHTMLAttributes<T> {
  "checked"?: boolean | CellLike<boolean>;
  "disabled"?: boolean | CellLike<boolean>;
  "value"?: string | CellLike<string>;
  "name"?: string | CellLike<string>;
  "onct-change"?: EventHandler<{ checked: boolean; value: string }>;
}

interface CTInputOtpAttributes<T> extends CTHTMLAttributes<T> {
  "length"?: number | CellLike<number>;
  "value"?: string | CellLike<string>;
  "$value"?: CellLike<string>;
  "disabled"?: boolean | CellLike<boolean>;
  "name"?: string | CellLike<string>;
  "placeholder"?: string | CellLike<string>;
  "autoComplete"?: boolean | CellLike<boolean>;
  "autofocus"?: boolean | CellLike<boolean>;
  "onct-change"?: EventHandler<{ value: string }>;
  "onct-complete"?: EventHandler<{ value: string }>;
}

interface CTLabelAttributes<T> extends CTHTMLAttributes<T> {
  "for"?: string | CellLike<string>;
  "required"?: boolean | CellLike<boolean>;
  "disabled"?: boolean | CellLike<boolean>;
}

// Display component attributes
interface CTBadgeAttributes<T> extends CTHTMLAttributes<T> {
  "variant"?:
    | "default"
    | "secondary"
    | "destructive"
    | "outline"
    | CellLike<"default" | "secondary" | "destructive" | "outline">;
  "removable"?: boolean | CellLike<boolean>;
  "onct-remove"?: EventHandler<{}>;
}

interface CTChipAttributes<T> extends CTHTMLAttributes<T> {
  "label"?: string | CellLike<string>;
  "variant"?:
    | "default"
    | "primary"
    | "accent"
    | CellLike<"default" | "primary" | "accent">;
  "removable"?: boolean | CellLike<boolean>;
  "interactive"?: boolean | CellLike<boolean>;
  "onct-remove"?: EventHandler<{}>;
  "onct-click"?: EventHandler<{}>;
}

interface CTProgressAttributes<T> extends CTHTMLAttributes<T> {
  "value"?: number | CellLike<number>;
  "max"?: number | CellLike<number>;
  "indeterminate"?: boolean | CellLike<boolean>;
}

interface CTSkeletonAttributes<T> extends CTHTMLAttributes<T> {
  "variant"?:
    | "default"
    | "text"
    | "circular"
    | CellLike<"default" | "text" | "circular">;
  "animated"?: boolean | CellLike<boolean>;
  "width"?: string | CellLike<string>;
  "height"?: string | CellLike<string>;
}

interface CTSeparatorAttributes<T> extends CTHTMLAttributes<T> {
  "orientation"?:
    | "horizontal"
    | "vertical"
    | CellLike<"horizontal" | "vertical">;
  "decorative"?: boolean | CellLike<boolean>;
}

interface CTTileAttributes<T> extends CTHTMLAttributes<T> {
  "item"?: any | CellLike<any>;
  "summary"?: string | CellLike<string>;
  "clickable"?: boolean | CellLike<boolean>;
  "onct-click"?: EventHandler<{}>;
}

// Layout component attributes
interface CTGridAttributes<T> extends CTHTMLAttributes<T> {
  "columns"?: string | CellLike<string>;
  "rows"?: string | CellLike<string>;
  "gap"?: string | CellLike<string>;
  "rowGap"?: string | CellLike<string>;
  "columnGap"?: string | CellLike<string>;
  "align"?: string | CellLike<string>;
  "justify"?: string | CellLike<string>;
  "place"?: string | CellLike<string>;
  "flow"?: string | CellLike<string>;
  "padding"?: string | CellLike<string>;
}

interface CTHGroupAttributes<T> extends CTHTMLAttributes<T> {
  "gap"?: "sm" | "md" | "lg" | CellLike<"sm" | "md" | "lg">;
  "wrap"?: boolean | CellLike<boolean>;
  "align"?:
    | "start"
    | "center"
    | "end"
    | "stretch"
    | "baseline"
    | CellLike<"start" | "center" | "end" | "stretch" | "baseline">;
  "justify"?:
    | "start"
    | "center"
    | "end"
    | "between"
    | "around"
    | "evenly"
    | CellLike<"start" | "center" | "end" | "between" | "around" | "evenly">;
}

interface CTVGroupAttributes<T> extends CTHTMLAttributes<T> {
  "gap"?: "sm" | "md" | "lg" | CellLike<"sm" | "md" | "lg">;
  "align"?:
    | "start"
    | "center"
    | "end"
    | "stretch"
    | CellLike<"start" | "center" | "end" | "stretch">;
  "justify"?:
    | "start"
    | "center"
    | "end"
    | "between"
    | "around"
    | "evenly"
    | CellLike<"start" | "center" | "end" | "between" | "around" | "evenly">;
}

interface CTAspectRatioAttributes<T> extends CTHTMLAttributes<T> {
  "ratio"?: string | CellLike<string>;
}

// Resizable component attributes
interface CTResizablePanelAttributes<T> extends CTHTMLAttributes<T> {
  "minSize"?: number | CellLike<number>;
  "defaultSize"?: number | CellLike<number>;
  "maxSize"?: number | CellLike<number>;
  "collapsible"?: boolean | CellLike<boolean>;
}

interface CTResizablePanelGroupAttributes<T> extends CTHTMLAttributes<T> {
  "direction"?: "horizontal" | "vertical" | CellLike<"horizontal" | "vertical">;
}

interface CTResizableHandleAttributes<T> extends CTHTMLAttributes<T> {
  "withHandle"?: boolean | CellLike<boolean>;
}

// Other component attributes
interface CTScrollAreaAttributes<T> extends CTHTMLAttributes<T> {
  "orientation"?:
    | "vertical"
    | "horizontal"
    | "both"
    | CellLike<"vertical" | "horizontal" | "both">;
}

interface CTToolCallAttributes<T> extends CTHTMLAttributes<T> {
  "call"?: any | CellLike<any>;
  "result"?: any | CellLike<any>;
  "expanded"?: boolean | CellLike<boolean>;
}

// Map component types
interface CTMapLatLng {
  lat: number;
  lng: number;
}

interface CTMapBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

interface CTMapMarker {
  position: CTMapLatLng;
  title?: string;
  description?: string;
  icon?: string;
  popup?: any;
  draggable?: boolean;
}

interface CTMapCircle {
  center: CTMapLatLng;
  radius: number;
  color?: string;
  fillOpacity?: number;
  strokeWidth?: number;
  title?: string;
  description?: string;
  popup?: any;
}

interface CTMapPolyline {
  points: CTMapLatLng[];
  color?: string;
  strokeWidth?: number;
  dashArray?: string;
}

interface CTMapValue {
  markers?: CTMapMarker[];
  circles?: CTMapCircle[];
  polylines?: CTMapPolyline[];
}

interface CTMapAttributes<T> extends CTHTMLAttributes<T> {
  "value"?: CTMapValue | CellLike<CTMapValue>;
  "$value"?: CTMapValue | CellLike<CTMapValue>;
  "center"?: CTMapLatLng | CellLike<CTMapLatLng | null> | null;
  "$center"?: CTMapLatLng | CellLike<CTMapLatLng | null> | null;
  "zoom"?: number | CellLike<number | null> | null;
  "$zoom"?: number | CellLike<number | null> | null;
  "bounds"?: CTMapBounds | CellLike<CTMapBounds | null> | null;
  "$bounds"?: CTMapBounds | CellLike<CTMapBounds | null> | null;
  "fitToBounds"?: boolean | CellLike<boolean>;
  "interactive"?: boolean | CellLike<boolean>;
  "onct-click"?: (event: CustomEvent<{ lat: number; lng: number }>) => void;
  "onct-bounds-change"?: (
    event: CustomEvent<
      { bounds: CTMapBounds; center: CTMapLatLng; zoom: number }
    >,
  ) => void;
  "onct-marker-click"?: (
    event: CustomEvent<
      { marker: CTMapMarker; index: number; lat: number; lng: number }
    >,
  ) => void;
  "onct-marker-drag-end"?: (
    event: CustomEvent<
      {
        marker: CTMapMarker;
        index: number;
        position: CTMapLatLng;
        oldPosition: CTMapLatLng;
      }
    >,
  ) => void;
  "onct-circle-click"?: (
    event: CustomEvent<
      { circle: CTMapCircle; index: number; lat: number; lng: number }
    >,
  ) => void;
}

interface CTMapElement extends CTHTMLElement {}

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
    // Our renderer (`@commontools/api#h`) outputs `VNode`s,
    // but also accepts cells containing objects with [UI] properties
    // (patterns used as components return OpaqueCell<{[UI]: VNode}>).
    type Element = JSXElement;

    interface IntrinsicElements extends DOMIntrinsicElements {
      //[elemName: string]: any;
      "ct-cell-link": CTDOM.DetailedHTMLProps<
        CTCellLinkAttributes<CTCellLinkElement>,
        CTCellLinkElement
      >;
      "ct-space-link": CTDOM.DetailedHTMLProps<
        CTSpaceLinkAttributes<CTSpaceLinkElement>,
        CTSpaceLinkElement
      >;
      "ct-outliner": CTDOM.DetailedHTMLProps<
        CTOutlinerAttributes<CTOutlinerElement>,
        CTOutlinerElement
      >;
      "ct-loader": CTDOM.DetailedHTMLProps<
        CTLoaderAttributes<CTLoaderElement>,
        CTLoaderElement
      >;
      "ct-input": CTDOM.DetailedHTMLProps<
        CTInputAttributes<CTInputElement>,
        CTInputElement
      >;
      "ct-textarea": CTDOM.DetailedHTMLProps<
        CTTextAreaAttributes<CTTextAreaElement>,
        CTTextAreaElement
      >;
      "ct-file-input": CTDOM.DetailedHTMLProps<
        CTFileInputAttributes<CTFileInputElement>,
        CTFileInputElement
      >;
      "ct-image-input": CTDOM.DetailedHTMLProps<
        CTImageInputAttributes<CTImageInputElement>,
        CTImageInputElement
      >;
      "ct-checkbox": CTDOM.DetailedHTMLProps<
        CTCheckboxAttributes<CTCheckboxElement>,
        CTCheckboxElement
      >;
      "ct-autocomplete": CTDOM.DetailedHTMLProps<
        CTAutocompleteAttributes<CTAutocompleteElement>,
        CTAutocompleteElement
      >;
      "ct-select": CTDOM.DetailedHTMLProps<
        CTSelectAttributes<CTSelectElement>,
        CTSelectElement
      >;
      "ct-radio-group": CTDOM.DetailedHTMLProps<
        CTRadioGroupAttributes<CTRadioGroupElement>,
        CTRadioGroupElement
      >;
      "ct-picker": CTDOM.DetailedHTMLProps<
        CTPickerAttributes<CTPickerElement>,
        CTPickerElement
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
      "ct-autostart": CTDOM.DetailedHTMLProps<
        CTAutostartAttributes<CTAutostartElement>,
        CTAutostartElement
      >;
      "ct-autolayout": CTDOM.DetailedHTMLProps<
        CTAutoLayoutAttributes<CTAutoLayoutElement>,
        CTAutoLayoutElement
      >;
      "ct-button": CTDOM.DetailedHTMLProps<
        CTButtonAttributes<CTButtonElement>,
        CTButtonElement
      >;
      "ct-copy-button": CTDOM.DetailedHTMLProps<
        CTCopyButtonAttributes<CTCopyButtonElement>,
        CTCopyButtonElement
      >;
      "ct-fab": CTDOM.DetailedHTMLProps<
        CTFabAttributes<CTFabElement>,
        CTFabElement
      >;
      "ct-modal": CTDOM.DetailedHTMLProps<
        CTModalAttributes<CTModalElement>,
        CTModalElement
      >;
      "ct-modal-provider": CTDOM.DetailedHTMLProps<
        CTModalProviderAttributes<CTModalProviderElement>,
        CTModalProviderElement
      >;
      "ct-file-download": CTDOM.DetailedHTMLProps<
        CTFileDownloadAttributes<CTFileDownloadElement>,
        CTFileDownloadElement
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
      "ct-markdown": CTDOM.DetailedHTMLProps<
        CTMarkdownAttributes<CTMarkdownElement>,
        CTMarkdownElement
      >;
      "ct-card": CTDOM.DetailedHTMLProps<
        CTCardAttributes<CTCardElement>,
        CTCardElement
      >;
      "ct-question": CTDOM.DetailedHTMLProps<
        CTQuestionAttributes<CTQuestionElement>,
        CTQuestionElement
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
      "ct-cell-context": CTDOM.DetailedHTMLProps<
        CTCellContextAttributes<CTCellContextElement>,
        CTCellContextElement
      >;
      "ct-drag-source": CTDOM.DetailedHTMLProps<
        CTDragSourceAttributes<CTDragSourceElement>,
        CTDragSourceElement
      >;
      "ct-drop-zone": CTDOM.DetailedHTMLProps<
        CTDropZoneAttributes<CTDropZoneElement>,
        CTDropZoneElement
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
      "ct-message-beads": CTDOM.DetailedHTMLProps<
        CTMessageBeadsAttributes<CTMessageBeadsElement>,
        CTMessageBeadsElement
      >;
      "ct-attachments-bar": CTDOM.DetailedHTMLProps<
        CTAttachmentsBarAttributes<CTAttachmentsBarElement>,
        CTAttachmentsBarElement
      >;
      "ct-ct-collapsible": CTDOM.DetailedHTMLProps<
        CTHTMLAttributes<CTCTCollapsibleElement>,
        CTCTCollapsibleElement
      >;
      "ct-canvas": CTDOM.DetailedHTMLProps<
        CTCanvasAttributes<CTCanvasElement>,
        CTCanvasElement
      >;
      "ct-draggable": CTDOM.DetailedHTMLProps<
        CTDraggableAttributes<CTDraggableElement>,
        CTDraggableElement
      >;
      "ct-alert": CTDOM.DetailedHTMLProps<
        CTAlertAttributes<CTAlertElement>,
        CTAlertElement
      >;
      "os-container": CTDOM.DetailedHTMLProps<
        CTHTMLAttributes<CTHTMLElement>,
        CTHTMLElement
      >;
      "ct-piece": CTDOM.DetailedHTMLProps<
        CTPieceAttributes<CTPieceElement>,
        CTPieceElement
      >;
      "ct-voice-input": CTDOM.DetailedHTMLProps<
        CTVoiceInputAttributes<CTVoiceInputElement>,
        CTVoiceInputElement
      >;
      "ct-audio-visualizer": CTDOM.DetailedHTMLProps<
        CTAudioVisualizerAttributes<CTAudioVisualizerElement>,
        CTAudioVisualizerElement
      >;
      "ct-location": CTDOM.DetailedHTMLProps<
        CTLocationAttributes<CTLocationElement>,
        CTLocationElement
      >;
      "ct-fragment": CTDOM.DetailedHTMLProps<
        CTHTMLAttributes<CTFragmentElement>,
        CTFragmentElement
      >;
      "ct-iframe": CTDOM.DetailedHTMLProps<
        CTIframeAttributes<CTIFrameElement>,
        CTIFrameElement
      >;
      "ct-updater": CTDOM.DetailedHTMLProps<
        CTUpdaterAttributes<CTUpdaterElement>,
        CTUpdaterElement
      >;
      "ct-google-oauth": CTDOM.DetailedHTMLProps<
        CTGoogleOAuthAttributes<CTGoogleOAuthElement>,
        CTGoogleOAuthElement
      >;
      "ct-plaid-link": CTDOM.DetailedHTMLProps<
        CTPlaidLinkAttributes<CTPlaidLinkElement>,
        CTPlaidLinkElement
      >;
      "ct-hstack": CTDOM.DetailedHTMLProps<
        CTStackAttributes<CTHStackElement>,
        CTHStackElement
      >;
      "ct-vstack": CTDOM.DetailedHTMLProps<
        CTStackAttributes<CTVStackElement>,
        CTVStackElement
      >;

      // Tab components
      "ct-tabs": CTDOM.DetailedHTMLProps<
        CTTabsAttributes<CTTabsElement>,
        CTTabsElement
      >;
      "ct-tab": CTDOM.DetailedHTMLProps<
        CTTabAttributes<CTTabElement>,
        CTTabElement
      >;
      "ct-tab-list": CTDOM.DetailedHTMLProps<
        CTTabListAttributes<CTTabListElement>,
        CTTabListElement
      >;
      "ct-tab-panel": CTDOM.DetailedHTMLProps<
        CTTabPanelAttributes<CTTabPanelElement>,
        CTTabPanelElement
      >;

      // Accordion components
      "ct-accordion": CTDOM.DetailedHTMLProps<
        CTAccordionAttributes<CTAccordionElement>,
        CTAccordionElement
      >;
      "ct-accordion-item": CTDOM.DetailedHTMLProps<
        CTAccordionItemAttributes<CTAccordionItemElement>,
        CTAccordionItemElement
      >;

      // Form components
      "ct-form": CTDOM.DetailedHTMLProps<
        CTFormAttributes<CTFormElement>,
        CTFormElement
      >;
      "ct-slider": CTDOM.DetailedHTMLProps<
        CTSliderAttributes<CTSliderElement>,
        CTSliderElement
      >;
      "ct-switch": CTDOM.DetailedHTMLProps<
        CTSwitchAttributes<CTSwitchElement>,
        CTSwitchElement
      >;
      "ct-toggle": CTDOM.DetailedHTMLProps<
        CTToggleAttributes<CTToggleElement>,
        CTToggleElement
      >;
      "ct-toggle-group": CTDOM.DetailedHTMLProps<
        CTToggleGroupAttributes<CTToggleGroupElement>,
        CTToggleGroupElement
      >;
      "ct-radio": CTDOM.DetailedHTMLProps<
        CTRadioAttributes<CTRadioElement>,
        CTRadioElement
      >;
      "ct-input-otp": CTDOM.DetailedHTMLProps<
        CTInputOtpAttributes<CTInputOtpElement>,
        CTInputOtpElement
      >;
      "ct-label": CTDOM.DetailedHTMLProps<
        CTLabelAttributes<CTLabelElement>,
        CTLabelElement
      >;

      // Display components
      "ct-badge": CTDOM.DetailedHTMLProps<
        CTBadgeAttributes<CTBadgeElement>,
        CTBadgeElement
      >;
      "ct-chip": CTDOM.DetailedHTMLProps<
        CTChipAttributes<CTChipElement>,
        CTChipElement
      >;
      "ct-progress": CTDOM.DetailedHTMLProps<
        CTProgressAttributes<CTProgressElement>,
        CTProgressElement
      >;
      "ct-skeleton": CTDOM.DetailedHTMLProps<
        CTSkeletonAttributes<CTSkeletonElement>,
        CTSkeletonElement
      >;
      "ct-separator": CTDOM.DetailedHTMLProps<
        CTSeparatorAttributes<CTSeparatorElement>,
        CTSeparatorElement
      >;
      "ct-tile": CTDOM.DetailedHTMLProps<
        CTTileAttributes<CTTileElement>,
        CTTileElement
      >;

      // Layout components
      "ct-grid": CTDOM.DetailedHTMLProps<
        CTGridAttributes<CTGridElement>,
        CTGridElement
      >;
      "ct-hgroup": CTDOM.DetailedHTMLProps<
        CTHGroupAttributes<CTHGroupElement>,
        CTHGroupElement
      >;
      "ct-vgroup": CTDOM.DetailedHTMLProps<
        CTVGroupAttributes<CTVGroupElement>,
        CTVGroupElement
      >;
      "ct-aspect-ratio": CTDOM.DetailedHTMLProps<
        CTAspectRatioAttributes<CTAspectRatioElement>,
        CTAspectRatioElement
      >;

      // Resizable components
      "ct-resizable-panel": CTDOM.DetailedHTMLProps<
        CTResizablePanelAttributes<CTResizablePanelElement>,
        CTResizablePanelElement
      >;
      "ct-resizable-panel-group": CTDOM.DetailedHTMLProps<
        CTResizablePanelGroupAttributes<CTResizablePanelGroupElement>,
        CTResizablePanelGroupElement
      >;
      "ct-resizable-handle": CTDOM.DetailedHTMLProps<
        CTResizableHandleAttributes<CTResizableHandleElement>,
        CTResizableHandleElement
      >;

      // Other components
      "ct-scroll-area": CTDOM.DetailedHTMLProps<
        CTScrollAreaAttributes<CTScrollAreaElement>,
        CTScrollAreaElement
      >;
      "ct-tool-call": CTDOM.DetailedHTMLProps<
        CTToolCallAttributes<CTToolCallElement>,
        CTToolCallElement
      >;

      // Map component
      "ct-map": CTDOM.DetailedHTMLProps<
        CTMapAttributes<CTMapElement>,
        CTMapElement
      >;

      // Chart components
      "ct-chart": CTDOM.DetailedHTMLProps<
        CTChartAttributes<CTChartElement>,
        CTChartElement
      >;
      "ct-line-mark": CTDOM.DetailedHTMLProps<
        CTLineMarkAttributes<CTLineMarkElement>,
        CTLineMarkElement
      >;
      "ct-area-mark": CTDOM.DetailedHTMLProps<
        CTAreaMarkAttributes<CTAreaMarkElement>,
        CTAreaMarkElement
      >;
      "ct-bar-mark": CTDOM.DetailedHTMLProps<
        CTBarMarkAttributes<CTBarMarkElement>,
        CTBarMarkElement
      >;
      "ct-dot-mark": CTDOM.DetailedHTMLProps<
        CTDotMarkAttributes<CTDotMarkElement>,
        CTDotMarkElement
      >;
    }
  }
}

export {};
