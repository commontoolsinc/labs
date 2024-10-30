import "@shoelace-style/shoelace";
import { view } from "../../hyperscript/render.js";
import { basicProps, t } from "../../hyperscript/schema-helpers.js";

export const alert = view("sl-alert", {
  ...basicProps(),
  open: t("boolean"),
  variant: t("string"),
});

export const avatar = view("sl-avatar", {
  ...basicProps(),
  image: t("string"),
  label: t("string"),
  initials: t("string"),
  loading: t("string"),
  shape: t("string"),
});
