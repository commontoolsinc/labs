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
