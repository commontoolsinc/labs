export type CssValue = string | number;
export type CssRules = Record<string, CssValue>;
export type CssSelector = string;
export type StyleSheet = Record<string, CssRules>;

export type Option<T> = T | null | undefined;

const prune = <T>(record: Record<string, Option<T>>): Record<string, T> => {
  const pruned: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value != null) {
      pruned[key] = value;
    }
  }
  return pruned;
};

export const padding = (
  top: Option<CssValue>,
  right: Option<CssValue>,
  bottom: Option<CssValue>,
  left: Option<CssValue>,
) =>
  prune({
    paddingTop: top,
    paddingRight: right,
    paddingBottom: bottom,
    paddingLeft: left,
  });

export const margin = (
  top: Option<CssValue>,
  right: Option<CssValue>,
  bottom: Option<CssValue>,
  left: Option<CssValue>,
) =>
  prune({
    marginTop: top,
    marginRight: right,
    marginBottom: bottom,
    marginLeft: left,
  });

export const paddingStep = (step: number) => {
  const size = `calc(var(--unit) * ${step})`;
  return {
    [`.p-${step}`]: padding(size, size, size, size),
    [`.pt-${step}`]: padding(size, null, null, null),
    [`.pr-${step}`]: padding(null, size, null, null),
    [`.pb-${step}`]: padding(null, null, size, null),
    [`.pl-${step}`]: padding(null, null, null, size),
    [`.px-${step}`]: padding(null, size, null, size),
    [`.py-${step}`]: padding(size, null, size, null),
  };
};

export const marginStep = (step: number) => {
  const size = `calc(var(--unit) * ${step})`;
  return {
    [`.m-${step}`]: margin(size, size, size, size),
    [`.mt-${step}`]: margin(size, null, null, null),
    [`.mr-${step}`]: margin(null, size, null, null),
    [`.mb-${step}`]: margin(null, null, size, null),
    [`.ml-${step}`]: margin(null, null, null, size),
    [`.mx-${step}`]: margin(null, size, null, size),
    [`.my-${step}`]: margin(size, null, size, null),
  };
};

const stepRulesWith = <T>(
  steps: Array<T>,
  generate: (value: T) => StyleSheet,
) => {
  const sheet: StyleSheet = {};
  for (const step of steps) {
    Object.assign(sheet, generate(step));
  }
  return sheet;
};

export const spacing = () => {
  const steps = [
    0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16,
    20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96,
  ];
  return {
    ...stepRulesWith(steps, marginStep),
    ...stepRulesWith(steps, paddingStep),
  };
};

export const base = () => ({
  ":root": {
    "--unit": 4,
  },
});

export const all = () => ({
  ...base(),
  ...spacing(),
});

export const camelCaseToKababCase = (camelCase: string) => {
  return camelCase.replace(/([A-Z])/g, "-$1").toLowerCase();
};

export const toCssValue = (value: CssValue) =>
  typeof value === "string" ? value : `${value}px`;

export const toPropString = (key: string, value: CssValue) =>
  `${camelCaseToKababCase(key)}: ${toCssValue(value)};`;

export const toRulesetString = (selector: CssSelector, rules: CssRules) => {
  const cssRules = Object.entries(rules).map((pair) => {
    const [key, value] = pair;
    return toPropString(key, value);
  });
  const body = cssRules.join("");
  return `${selector} {${body}}`;
};

export const toStylesheetString = (stylesheet: StyleSheet) => {
  return Object.entries(stylesheet)
    .map((pair) => {
      const [className, rules] = pair;
      return toRulesetString(className, rules);
    })
    .join("");
};

export const compileStylesheet = (sheet: StyleSheet): CSSStyleSheet => {
  const stylesheet = new CSSStyleSheet();
  const styleString = toStylesheetString(sheet);
  stylesheet.replaceSync(styleString);
  return stylesheet;
};
