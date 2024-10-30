import "@shoelace-style/shoelace";
import { view } from "../../hyperscript/render.js";
import { basicProps, t, binding } from "../../hyperscript/schema-helpers.js";

export const alert = view("sl-alert", {
  ...basicProps(),
  open: t("boolean"),
  variant: t("string"),
});

export const animatedImage = view("sl-animated-image", {
  ...basicProps(),
  src: t("string"),
  alt: t("string"),
  play: t("boolean"),
});

export const avatar = view("sl-avatar", {
  ...basicProps(),
  image: t("string"),
  label: t("string"),
  initials: t("string"),
  loading: t("string"),
  shape: t("string"),
});

export const badge = view("sl-badge", {
  ...basicProps(),
  variant: t("string"),
  pill: t("boolean"),
  pulse: t("boolean"),
});

export const breadcrumb = view("sl-breadcrumb", {
  ...basicProps(),
  label: t("string"),
});

export const breadcrumbItem = view("sl-breadcrumb-item", {
  ...basicProps(),
  href: t("string"),
  rel: t("string"),
});

export const button = view("sl-button", {
  ...basicProps(),
  "@sl-blur": binding(),
  "@sl-focus": binding(),
  "@sl-invalid": binding(),
  variant: t("string"),
  size: t("size"),
  caret: t("boolean"),
  disabled: t("boolean"),
  loading: t("boolean"),
  outline: t("boolean"),
  pill: t("boolean"),
  circle: t("boolean"),
  type: t("string"),
  name: t("string"),
  value: t("string"),
  href: t("string"),
  rel: t("string"),
});

export const buttonGroup = view("sl-button-group", {
  ...basicProps(),
  label: t("string"),
});

export const card = view("sl-card", {
  ...basicProps(),
});

export const carousel = view("sl-carousel", {
  ...basicProps(),
  loop: t("boolean"),
  navigation: t("boolean"),
  pagination: t("boolean"),
  autoplay: t("boolean"),
  autoplayInterval: t("number"),
  slidesPerPage: t("number"),
  slidesPerMove: t("number"),
  orientation: t("string"),
  mouseDragging: t("boolean"),
});

export const carouselItem = view("sl-carousel-item", {
  ...basicProps(),
});

export const checkbox = view("sl-checkbox", {
  ...basicProps(),
  "@sl-blur": binding(),
  "@sl-change": binding(),
  "@sl-focus": binding(),
  "@sl-input": binding(),
  "@sl-invalid": binding(),
  name: t("string"),
  value: t("string"),
  size: t("string"),
  disabled: t("boolean"),
  checked: t("string"),
  indeterminate: t("boolean"),
  defaultChecked: t("boolean"),
  required: t("boolean"),
  helpText: t("string"),
});

export const colorPicker = view("sl-color-picker", {
  ...basicProps(),
  "@sl-blur": binding(),
  "@sl-change": binding(),
  "@sl-focus": binding(),
  "@sl-input": binding(),
  "@sl-invalid": binding(),
  value: t("string"),
  defaultValue: t("string"),
  label: t("string"),
  format: t("string"),
  inline: t("boolean"),
  size: t("string"),
  noFormatToggle: t("boolean"),
  name: t("string"),
  disabled: t("boolean"),
  hoist: t("boolean"),
  opacity: t("boolean"),
  uppercase: t("boolean"),
  swatches: t("string"),
  required: t("boolean"),
});

export const copyButton = view("sl-copy-button", {
  ...basicProps(),
  "@sl-blur": binding(),
  "@sl-change": binding(),
  "@sl-focus": binding(),
  "@sl-input": binding(),
  "@sl-invalid": binding(),
  value: t("string"),
  from: t("string"),
  disabled: t("boolean"),
  copyLabel: t("string"),
  successLabel: t("string"),
  errorLabel: t("string"),
  feedbackDuration: t("number"),
  tooltipPlacement: t("string"),
  hoist: t("boolean"),
});

export const details = view("sl-details", {
  ...basicProps(),
  "@sl-show": binding(),
  "@sl-after-show": binding(),
  "@sl-hide": binding(),
  "@sl-after-hide": binding(),
  "@sl-initial-focus": binding(),
  "@sl-request-close": binding(),
  open: t("boolean"),
  summary: t("string"),
  disabled: t("boolean"),
});

export const dialog = view("sl-dialog", {
  ...basicProps(),
  "@sl-show": binding(),
  "@sl-after-show": binding(),
  "@sl-hide": binding(),
  "@sl-after-hide": binding(),
  open: t("boolean"),
  label: t("string"),
  noHeader: t("boolean"),
});

export const divider = view("sl-divider", {
  ...basicProps(),
  vertical: t("boolean"),
});

export const drawer = view("sl-drawer", {
  ...basicProps(),
  open: t("boolean"),
  label: t("string"),
  placement: t("string"),
  contained: t("boolean"),
  noHeader: t("boolean"),
});

export const dropdown = view("sl-dropdown", {
  ...basicProps(),
  "@sl-show": binding(),
  "@sl-after-show": binding(),
  "@sl-hide": binding(),
  "@sl-after-hide": binding(),
  open: t("boolean"),
  placement: t("string"),
  disabled: t("boolean"),
  stayOpenOnSelect: t("boolean"),
  distance: t("number"),
  skidding: t("number"),
  hoist: t("boolean"),
  sync: t("string"),
  contained: t("boolean"),
});

export const formatBytes = view("sl-format-bytes", {
  ...basicProps(),
  value: t("number"),
  unit: t("string"),
  display: t("string"),
});

export const formatDate = view("sl-format-date", {
  ...basicProps(),
  date: t("string"),
  weekday: t("string"),
  era: t("string"),
  year: t("string"),
  month: t("string"),
  day: t("string"),
  hour: t("string"),
  minute: t("string"),
  second: t("string"),
  timeZoneName: t("string"),
  timeZone: t("string"),
  hourFormat: t("string"),
});

export const formatNumber = view("sl-format-number", {
  ...basicProps(),
  value: t("number"),
  type: t("string"),
  noGrouping: t("boolean"),
  currency: t("string"),
  currencyDisplay: t("string"),
  minimumIntegerDigits: t("number"),
  minimumFractionDigits: t("number"),
  maximumFractionDigits: t("number"),
  minimumSignificantDigits: t("number"),
  maximumSignificantDigits: t("number"),
});

export const icon = view("sl-icon", {
  ...basicProps(),
  name: t("string"),
  src: t("string"),
  label: t("string"),
  library: t("string"),
});

export const iconButton = view("sl-icon-button", {
  ...basicProps(),
  "@sl-blur": binding(),
  "@sl-focus": binding(),
  name: t("string"),
  src: t("string"),
  href: t("boolean"),
  label: t("string"),
  library: t("string"),
  disabled: t("boolean"),
  download: t("string"),
});

export const imageComparer = view("sl-image-comparer", {
  ...basicProps(),
  position: t("number"),
});

export const input = view("sl-input", {
  ...basicProps(),
  "@sl-blur": binding(),
  "@sl-change": binding(),
  "@sl-clear": binding(),
  "@sl-focus": binding(),
  "@sl-input": binding(),
  "@sl-invalid": binding(),
  type: t("string"),
  name: t("string"),
  value: t("string"),
  defaultValue: t("string"),
  size: t("string"),
  filled: t("boolean"),
  pill: t("boolean"),
  label: t("string"),
  helpText: t("string"),
  clearable: t("boolean"),
  disabled: t("boolean"),
  passwordToggle: t("boolean"),
  passwordVisible: t("boolean"),
  placeholder: t("string"),
  noSpinButtons: t("boolean"),
  readonly: t("boolean"),
  minlength: t("number"),
  maxlength: t("number"),
  min: t("number"),
  max: t("number"),
  step: t("number"),
  pattern: t("string"),
  required: t("boolean"),
  autocapitalize: t("string"),
  autocorrect: t("string"),
  autocomplete: t("string"),
  autofocus: t("boolean"),
  enterkeyhint: t("string"),
  spellcheck: t("boolean"),
  inputmode: t("string"),
});

export const menu = view("sl-menu", {
  ...basicProps(),
});

export const menuItem = view("sl-menu-item", {
  ...basicProps(),
  "@sl-label-change": binding(),
  type: t("string"),
  checked: t("boolean"),
  value: t("string"),
  loading: t("boolean"),
  disabled: t("boolean"),
});

export const menuLabel = view("sl-menu-label", {
  ...basicProps(),
});

export const option = view("sl-option", {
  ...basicProps(),
  value: t("string"),
  disabled: t("boolean"),
});

export const popup = view("sl-popup", {
  ...basicProps(),
  active: t("boolean"),
  placement: t("string"),
  strategy: t("string"),
  distance: t("number"),
  skidding: t("number"),
  arrow: t("boolean"),
  arrowPlacement: t("string"),
  arrowPadding: t("number"),
  flip: t("boolean"),
  flipFallbackPlacements: t("string"),
  flipFallbackStrategy: t("string"),
  flipBoundary: t("object"),
  flipPadding: t("number"),
  shift: t("boolean"),
  shiftBoundary: t("object"),
  shiftPadding: t("number"),
  autoSizePadding: t("number"),
  hoverBridge: t("boolean"),
});

export const progressBar = view("sl-progress-bar", {
  ...basicProps(),
  value: t("number"),
  indeterminate: t("boolean"),
  label: t("string"),
});

export const progressRing = view("sl-progress-ring", {
  ...basicProps(),
  value: t("number"),
  label: t("string"),
});

export const qrCode = view("sl-qr-code", {
  ...basicProps(),
  value: t("string"),
  label: t("string"),
  size: t("number"),
  fill: t("string"),
  background: t("string"),
  radius: t("number"),
  errorCorrection: t("string"),
});

export const radio = view("sl-radio", {
  ...basicProps(),
  "@sl-blur": binding(),
  "@sl-focus": binding(),
  value: t("string"),
  size: t("string"),
  disabled: t("boolean"),
});

export const radioButton = view("sl-radio-button", {
  ...basicProps(),
  "@sl-change": binding(),
  "@sl-input": binding(),
  "@sl-invalid": binding(),
  value: t("string"),
  size: t("string"),
  pill: t("boolean"),
  disabled: t("boolean"),
});

export const radioGroup = view("sl-radio-group", {
  ...basicProps(),
  "@sl-change": binding(),
  "@sl-input": binding(),
  "@sl-invalid": binding(),
  value: t("string"),
  size: t("string"),
  label: t("string"),
  helpText: t("string"),
  required: t("boolean"),
});

export const range = view("sl-range", {
  ...basicProps(),
  "@sl-blur": binding(),
  "@sl-change": binding(),
  "@sl-focus": binding(),
  "@sl-input": binding(),
  "@sl-invalid": binding(),
  name: t("string"),
  value: t("number"),
  defaultValue: t("number"),
  label: t("string"),
  helpText: t("string"),
  disabled: t("boolean"),
  min: t("number"),
  max: t("number"),
  step: t("number"),
  tooltip: t("string"),
  tooltipFormatter: t("function"),
});

export const rating = view("sl-rating", {
  ...basicProps(),
  "@sl-change": binding(),
  "@sl-hover": binding(),
  value: t("number"),
  max: t("number"),
  precision: t("number"),
  readonly: t("boolean"),
  disabled: t("boolean"),
  getSymbol: t("function"),
});

export const relativeTime = view("sl-relative-time", {
  ...basicProps(),
  date: t("string"),
  format: t("string"),
  numeric: t("string"),
  sync: t("boolean"),
});

export const select = view("sl-select", {
  ...basicProps(),
  "@sl-change": binding(),
  "@sl-clear": binding(),
  "@sl-input": binding(),
  "@sl-focus": binding(),
  "@sl-blur": binding(),
  "@sl-show": binding(),
  "@sl-after-show": binding(),
  "@sl-hide": binding(),
  "@sl-after-hide": binding(),
  "@sl-invalid": binding(),
  name: t("string"),
  value: t("string"),
  defaultValue: t("string"),
  size: t("string"),
  label: t("string"),
  helpText: t("string"),
  placeholder: t("string"),
  multiple: t("boolean"),
  maxOptionsVisible: t("number"),
  disabled: t("boolean"),
  clearable: t("boolean"),
  required: t("boolean"),
  hoist: t("boolean"),
  open: t("boolean"),
  filled: t("boolean"),
  pill: t("boolean"),
  placement: t("string"),
});

export const skeleton = view("sl-skeleton", {
  ...basicProps(),
  effect: t("string"),
});

export const spinner = view("sl-spinner", {
  ...basicProps(),
});

export const splitPanel = view("sl-split-panel", {
  ...basicProps(),
  "@sl-reposition": binding(),
  position: t("number"),
  positionInPixels: t("number"),
  vertical: t("boolean"),
  disabled: t("boolean"),
  primary: t("string"),
  snap: t("string"),
  snapThreshold: t("number"),
});

export const toggleSwitch = view("sl-switch", {
  ...basicProps(),
  "@sl-blur": binding(),
  "@sl-change": binding(),
  "@sl-input": binding(),
  "@sl-invalid": binding(),
  "@sl-focus": binding(),
  name: t("string"),
  value: t("string"),
  size: t("string"),
  disabled: t("boolean"),
  required: t("boolean"),
  checked: t("boolean"),
  defaultChecked: t("boolean"),
});

export const tab = view("sl-tab", {
  ...basicProps(),
  "@sl-close": binding(),
  panel: t("string"),
  active: t("boolean"),
  closable: t("boolean"),
  disabled: t("boolean"),
});

export const tabGroup = view("sl-tab-group", {
  ...basicProps(),
  "@sl-tab-show": binding(),
  "@sl-tab-hide": binding(),
  placement: t("string"),
  activation: t("string"),
  noScrollControls: t("boolean"),
  fixedScrollControls: t("boolean"),
});

export const tabPanel = view("sl-tab-panel", {
  ...basicProps(),
  name: t("string"),
  active: t("boolean"),
});

export const tag = view("sl-tag", {
  ...basicProps(),
  "@sl-remove": binding(),
  variant: t("string"),
  size: t("string"),
  removable: t("boolean"),
  pill: t("boolean"),
});

export const textarea = view("sl-textarea", {
  ...basicProps(),
  "@sl-blur": binding(),
  "@sl-change": binding(),
  "@sl-focus": binding(),
  "@sl-input": binding(),
  "@sl-invalid": binding(),
  name: t("string"),
  value: t("string"),
  size: t("string"),
  filled: t("boolean"),
  label: t("string"),
  helpText: t("string"),
  placeholder: t("string"),
  rows: t("number"),
  resize: t("string"),
  disabled: t("boolean"),
  readonly: t("boolean"),
  minlength: t("number"),
  maxlength: t("number"),
  required: t("boolean"),
  autocapitalize: t("string"),
  autocorrect: t("string"),
  autocomplete: t("string"),
  autofocus: t("boolean"),
  enterkeyhint: t("string"),
  spellcheck: t("boolean"),
  inputmode: t("string"),
  defaultValue: t("string"),
});

export const tooltip = view("sl-tooltip", {
  ...basicProps(),
  "@sl-show": binding(),
  "@sl-after-show": binding(),
  "@sl-hide": binding(),
  "@sl-after-hide": binding(),
  content: t("string"),
  placement: t("string"),
  disabled: t("boolean"),
  distance: t("number"),
  open: t("boolean"),
  skidding: t("number"),
  trigger: t("string"),
  hoist: t("boolean"),
});

export const tree = view("sl-tree", {
  ...basicProps(),
  "@sl-selection-change": binding(),
  selection: t("string"),
});

export const treeItem = view("sl-tree-item", {
  ...basicProps(),
  "@sl-expand": binding(),
  "@sl-after-expand": binding(),
  "@sl-collapse": binding(),
  "@sl-after-collapse": binding(),
  "@sl-lazy-change": binding(),
  "@sl-lazy-load": binding(),
  expanded: t("boolean"),
  selected: t("boolean"),
  disabled: t("boolean"),
  lazy: t("boolean"),
});
