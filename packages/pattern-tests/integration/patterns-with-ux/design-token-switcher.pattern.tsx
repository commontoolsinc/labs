/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface TokenDefinition {
  background: string;
  foreground: string;
  accent: string;
}

type TokenCatalog = Record<string, TokenDefinition>;

const DEFAULT_TOKEN_CATALOG: TokenCatalog = {
  light: {
    background: "#ffffff",
    foreground: "#161616",
    accent: "#2f80ed",
  },
  midnight: {
    background: "#0b1220",
    foreground: "#f5f7fb",
    accent: "#5b8def",
  },
  contrast: {
    background: "#000000",
    foreground: "#ffdd00",
    accent: "#ff6f61",
  },
};

interface DesignTokenSwitcherArgs {
  tokens: Default<TokenCatalog, typeof DEFAULT_TOKEN_CATALOG>;
  activeToken: Default<string, "light">;
}

const sanitizeTokenName = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const sanitizeColor = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeDefinition = (
  value: unknown,
  fallback: TokenDefinition,
): TokenDefinition => {
  if (!value || typeof value !== "object") {
    return { ...fallback };
  }
  const record = value as Record<string, unknown>;
  return {
    background: sanitizeColor(record.background, fallback.background),
    foreground: sanitizeColor(record.foreground, fallback.foreground),
    accent: sanitizeColor(record.accent, fallback.accent),
  };
};

const sanitizeCatalog = (value: unknown): TokenCatalog => {
  const base: TokenCatalog = { ...DEFAULT_TOKEN_CATALOG };
  if (!value || typeof value !== "object") {
    return base;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const definition = record[key];
    const fallback = base[key] ?? DEFAULT_TOKEN_CATALOG.light;
    base[key] = sanitizeDefinition(definition, fallback);
  }
  return base;
};

const findNextName = (current: string, names: string[]): string => {
  if (names.length === 0) return current;
  const index = names.indexOf(current);
  if (index === -1) return names[0];
  return names[(index + 1) % names.length];
};

const switchDesignToken = handler(
  (
    event: { token?: string } | undefined,
    context: {
      active: Cell<string>;
      tokens: Cell<TokenCatalog>;
      history: Cell<string[]>;
    },
  ) => {
    const catalog = sanitizeCatalog(context.tokens.get());
    const names = Object.keys(catalog).sort((a, b) => a.localeCompare(b));
    const fallback = names[0] ?? "light";
    const current = sanitizeTokenName(context.active.get()) ?? fallback;
    const requested = sanitizeTokenName(event?.token);
    const next = requested && names.includes(requested)
      ? requested
      : findNextName(current, names);
    context.active.set(next);
    const history = Array.isArray(context.history.get())
      ? context.history.get()
      : [];
    context.history.set([...history, next]);
  },
);

export const designTokenSwitcherUx = recipe<DesignTokenSwitcherArgs>(
  "Design Token Switcher (UX)",
  ({ tokens, activeToken }) => {
    const appliedHistory = cell<string[]>([]);

    const sanitizedCatalog = lift((value: TokenCatalog | undefined) =>
      sanitizeCatalog(value)
    )(tokens);

    const tokenNames = lift((catalog: TokenCatalog) =>
      Object.keys(catalog).sort((a, b) => a.localeCompare(b))
    )(sanitizedCatalog);

    const currentToken = lift((input: {
      candidate?: string;
      names: string[];
    }) => {
      const names = input.names;
      if (names.length === 0) return "light";
      const sanitized = sanitizeTokenName(input.candidate);
      return sanitized && names.includes(sanitized) ? sanitized : names[0];
    })({ candidate: activeToken, names: tokenNames });

    const currentDefinition = lift((input: {
      name: string;
      catalog: TokenCatalog;
    }) =>
      input.catalog[input.name] ??
        sanitizeDefinition(undefined, DEFAULT_TOKEN_CATALOG.light)
    )({ name: currentToken, catalog: sanitizedCatalog });

    const backgroundColor = lift((definition: TokenDefinition) =>
      definition.background
    )(currentDefinition);

    const foregroundColor = lift((definition: TokenDefinition) =>
      definition.foreground
    )(currentDefinition);

    const accentColor = lift((definition: TokenDefinition) =>
      definition.accent
    )(currentDefinition);

    const colorSummary = lift((definition: TokenDefinition) =>
      `${definition.background}/${definition.foreground}/${definition.accent}`
    )(currentDefinition);

    const preview = lift((definition: TokenDefinition) => ({
      background: definition.background,
      foreground: definition.foreground,
      accent: definition.accent,
      summary: `bg ${definition.background} fg ${definition.foreground}`,
    }))(currentDefinition);

    const historyView = lift((value: string[] | undefined) =>
      Array.isArray(value) ? value : []
    )(appliedHistory);

    const lastApplied = lift((value: string[]) => {
      if (value.length === 0) return "none";
      return value[value.length - 1];
    })(historyView);

    // UI-specific handlers
    const switchToNext = handler(
      (_event, context: {
        active: Cell<string>;
        tokens: Cell<TokenCatalog>;
        history: Cell<string[]>;
      }) => {
        const catalog = sanitizeCatalog(context.tokens.get());
        const names = Object.keys(catalog).sort((a, b) => a.localeCompare(b));
        const fallback = names[0] ?? "light";
        const current = sanitizeTokenName(context.active.get()) ?? fallback;
        const next = findNextName(current, names);
        context.active.set(next);
        const history = Array.isArray(context.history.get())
          ? context.history.get()
          : [];
        context.history.set([...history, next]);
      },
    );

    const tokenField = cell<string>("");

    const switchToSpecific = handler(
      (_event, context: {
        active: Cell<string>;
        tokens: Cell<TokenCatalog>;
        history: Cell<string[]>;
        tokenInput: Cell<string>;
      }) => {
        const catalog = sanitizeCatalog(context.tokens.get());
        const names = Object.keys(catalog).sort((a, b) => a.localeCompare(b));
        const fallback = names[0] ?? "light";
        const inputVal = context.tokenInput.get();
        const requested = sanitizeTokenName(inputVal);
        if (requested && names.includes(requested)) {
          context.active.set(requested);
          const history = Array.isArray(context.history.get())
            ? context.history.get()
            : [];
          context.history.set([...history, requested]);
          context.tokenInput.set("");
        }
      },
    );

    const name = lift((token: string) => `Design Tokens · ${token}`)(
      currentToken,
    );

    const themePreview = lift((input: {
      bg: string;
      fg: string;
      accent: string;
      token: string;
    }) => {
      const bgColor = input.bg;
      const fgColor = input.fg;
      const accentColor = input.accent;
      const tokenName = input.token;

      const containerStyle = "padding: 2rem; border-radius: 12px; " +
        "background: " + bgColor + "; " +
        "border: 2px solid " + accentColor + "; " +
        "transition: all 0.3s ease;";

      return h(
        "div",
        { style: containerStyle },
        h(
          "div",
          { style: "text-align: center; color: " + fgColor + ";" },
          h(
            "div",
            {
              style:
                "font-size: 1.75rem; font-weight: bold; margin-bottom: 1rem;",
            },
            tokenName,
          ),
          h(
            "div",
            {
              style:
                "font-size: 0.875rem; opacity: 0.8; font-family: monospace;",
            },
            "Background: " + bgColor,
          ),
          h(
            "div",
            {
              style:
                "font-size: 0.875rem; opacity: 0.8; font-family: monospace;",
            },
            "Foreground: " + fgColor,
          ),
          h(
            "div",
            {
              style:
                "font-size: 0.875rem; opacity: 0.8; font-family: monospace;",
            },
            "Accent: " + accentColor,
          ),
        ),
      );
    })({
      bg: backgroundColor,
      fg: foregroundColor,
      accent: accentColor,
      token: currentToken,
    });

    const tokenList = lift((input: {
      names: string[];
      current: string;
    }) => {
      const names = input.names;
      const currentName = input.current;
      const elements = [];

      for (const tokenName of names) {
        const isCurrent = tokenName === currentName;
        const badgeStyle = isCurrent
          ? "display: inline-block; padding: 0.5rem 1rem; margin: 0.25rem; " +
            "border-radius: 8px; border: 2px solid #2f80ed; " +
            "background: #2f80ed; color: white; font-weight: bold;"
          : "display: inline-block; padding: 0.5rem 1rem; margin: 0.25rem; " +
            "border-radius: 8px; border: 1px solid #ccc; " +
            "background: white; color: #333;";

        elements.push(
          h("span", { style: badgeStyle }, tokenName),
        );
      }

      return h(
        "div",
        { style: "display: flex; flex-wrap: wrap; gap: 0.5rem;" },
        ...elements,
      );
    })({ names: tokenNames, current: currentToken });

    const historyDisplay = lift((history: string[]) => {
      if (history.length === 0) {
        return h(
          "div",
          { style: "padding: 1rem; color: #999; font-style: italic;" },
          "No token switches yet",
        );
      }

      const recent = history.slice().reverse().slice(0, 6);
      const elements = [];

      for (const token of recent) {
        elements.push(
          h(
            "div",
            {
              style: "padding: 0.5rem 0.75rem; margin: 0.25rem 0; " +
                "border-left: 3px solid #2f80ed; background: #f5f7fa;",
            },
            token,
          ),
        );
      }

      return h("div", {}, ...elements);
    })(historyView);

    const ui = (
      <div style="max-width: 800px; margin: 0 auto; padding: 1rem; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 2rem; border-radius: 12px; color: white; margin-bottom: 2rem;">
          <div style="font-size: 2rem; font-weight: bold; margin-bottom: 0.5rem;">
            Design Token Switcher
          </div>
          <div style="opacity: 0.9;">
            Manage and preview design tokens with theme switching
          </div>
        </div>

        <div style="background: white; border-radius: 12px; padding: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 1.5rem;">
          <div style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; color: #333;">
            Current Theme Preview
          </div>
          {themePreview}
        </div>

        <div style="background: white; border-radius: 12px; padding: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 1.5rem;">
          <div style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; color: #333;">
            Available Tokens
          </div>
          {tokenList}
        </div>

        <div style="background: white; border-radius: 12px; padding: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 1.5rem;">
          <div style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; color: #333;">
            Switch Token
          </div>

          <div style="margin-bottom: 1rem;">
            <ct-button
              onClick={switchToNext({
                active: activeToken,
                tokens,
                history: appliedHistory,
              })}
              style="width: 100%; padding: 0.75rem; background: #2f80ed; color: white; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer;"
            >
              Cycle to Next Token
            </ct-button>
          </div>

          <div style="display: flex; gap: 0.5rem;">
            <ct-input
              $value={tokenField}
              placeholder="Enter token name (e.g., midnight)"
              style="flex: 1; padding: 0.75rem; border: 1px solid #ccc; border-radius: 8px; font-size: 1rem;"
            />
            <ct-button
              onClick={switchToSpecific({
                active: activeToken,
                tokens,
                history: appliedHistory,
                tokenInput: tokenField,
              })}
              style="padding: 0.75rem 1.5rem; background: #5b8def; color: white; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer;"
            >
              Apply
            </ct-button>
          </div>
        </div>

        <div style="background: white; border-radius: 12px; padding: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <div style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; color: #333;">
            Switch History
          </div>
          {historyDisplay}
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      tokens: sanitizedCatalog,
      tokenNames,
      activeToken: currentToken,
      backgroundColor,
      foregroundColor,
      accentColor,
      preview,
      history: historyView,
      lastApplied,
      colorSummary,
      label: str`Active token ${currentToken} renders ${colorSummary}`,
      switchToken: switchDesignToken({
        active: activeToken,
        tokens,
        history: appliedHistory,
      }),
    };
  },
);
