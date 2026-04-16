import { createContext } from "@lit/context";

/**
 * Color scheme for dynamic theming (SwiftUI-style)
 */
export type ColorScheme = "light" | "dark" | "auto";

/**
 * Semantic color token that can be a concrete value or reference
 */
export type ColorToken = string | {
  light: string;
  dark: string;
};

/**
 * Comprehensive theme configuration for CF components
 */
export interface CFTheme {
  /** Font family for text content */
  fontFamily: string;
  /** Monospace font family for code */
  monoFontFamily: string;
  /** Base font size for UI elements */
  fontSize: string;
  /** Border radius for UI elements */
  borderRadius: string;
  /** Overall density/spacing preference */
  density: "compact" | "comfortable" | "spacious";
  /** Color scheme preference */
  colorScheme: ColorScheme;
  /** Animation speed preference */
  animationSpeed: "none" | "slow" | "normal" | "fast";
  /** Color palette with semantic tokens that adapt to light/dark */
  colors: {
    /** Primary brand color */
    primary: ColorToken;
    /** Primary foreground (text on primary) */
    primaryForeground: ColorToken;
    /** Secondary color */
    secondary: ColorToken;
    /** Secondary foreground */
    secondaryForeground: ColorToken;
    /** Main background color */
    background: ColorToken;
    /** Surface color (cards, containers) */
    surface: ColorToken;
    /** Surface hover state */
    surfaceHover: ColorToken;
    /** Primary text color */
    text: ColorToken;
    /** Muted/secondary text color */
    textMuted: ColorToken;
    /** Border color */
    border: ColorToken;
    /** Muted border color */
    borderMuted: ColorToken;
    /** Success color */
    success: ColorToken;
    /** Success foreground */
    successForeground: ColorToken;
    /** Error color */
    error: ColorToken;
    /** Error foreground */
    errorForeground: ColorToken;
    /** Warning color */
    warning: ColorToken;
    /** Warning foreground */
    warningForeground: ColorToken;
    /** Accent color for highlights */
    accent: ColorToken;
    /** Accent foreground */
    accentForeground: ColorToken;
  };
}

/**
 * Density scaling factors for different spacing contexts
 */
const DENSITY_SCALES = {
  compact: { tight: 0.75, normal: 0.85, loose: 1.0 },
  comfortable: { tight: 1.0, normal: 1.15, loose: 1.3 },
  spacious: { tight: 1.25, normal: 1.5, loose: 1.75 },
} as const;

/**
 * Base spacing values in rem that get scaled by density
 */
const BASE_SPACING = {
  xs: 0.125, // 2px at 16px base
  sm: 0.25, // 4px
  md: 0.5, // 8px
  lg: 0.75, // 12px
  xl: 1.0, // 16px
  xxl: 1.5, // 24px
} as const;

/**
 * Detect the current color scheme preference
 * @param scheme - Theme color scheme setting
 * @returns Resolved color scheme ("light" or "dark")
 */
export function resolveColorScheme(scheme: ColorScheme): "light" | "dark" {
  if (scheme === "auto") {
    // Check system preference
    if (typeof globalThis !== "undefined" && globalThis.matchMedia) {
      return globalThis.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    return "light"; // Fallback for non-browser environments
  }
  return scheme;
}

/**
 * Resolve a color token to a concrete color value
 * @param token - Color token (string or light/dark object)
 * @param colorScheme - Current color scheme
 * @returns Resolved color string
 */
export function resolveColor(
  token: ColorToken,
  colorScheme: "light" | "dark",
): string {
  if (typeof token === "string") {
    return token;
  }
  return token[colorScheme];
}

/**
 * Get semantic spacing value for a component context
 * @param density - Theme density setting
 * @param size - Base size (xs, sm, md, lg, xl, xxl)
 * @param context - Spacing context (tight, normal, loose)
 * @returns CSS custom property with fallback
 */
export function getSemanticSpacing(
  density: CFTheme["density"],
  size: keyof typeof BASE_SPACING,
  context: "tight" | "normal" | "loose" = "normal",
): string {
  const scale = DENSITY_SCALES[density][context];
  const baseValue = BASE_SPACING[size];
  const scaledValue = baseValue * scale;

  // Map to the closest spacing level for compatibility
  const spacingLevel = Math.min(4, Math.round(scaledValue * 4));
  const fallback = `${scaledValue}rem`;

  return `var(--cf-spacing-${spacingLevel}, ${fallback})`;
}

/**
 * Default theme values with SwiftUI-style adaptive colors
 */
export const defaultTheme: CFTheme = {
  fontFamily: "system-ui, -apple-system, sans-serif",
  monoFontFamily:
    "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
  fontSize: "1rem",
  borderRadius: "0.5rem",
  density: "comfortable",
  colorScheme: "light",
  animationSpeed: "normal",
  colors: {
    primary: {
      light: "#4f7dff",
      dark: "#6b93ff",
    },
    primaryForeground: {
      light: "#ffffff",
      dark: "#1a2a5c",
    },
    secondary: {
      light: "#d8dded",
      dark: "#3d4463",
    },
    secondaryForeground: {
      light: "#3a4568",
      dark: "#d8dded",
    },
    background: {
      light: "#eef1f8",
      dark: "#0f1219",
    },
    surface: {
      light: "#ffffff",
      dark: "#1c2030",
    },
    surfaceHover: {
      light: "#f5f6fa",
      dark: "#282d3e",
    },
    text: {
      light: "#313a5d",
      dark: "#e4e7f0",
    },
    textMuted: {
      light: "#8e94a8",
      dark: "#8e94a8",
    },
    border: {
      light: "rgba(67, 75, 97, 0.10)",
      dark: "rgba(200, 210, 230, 0.12)",
    },
    borderMuted: {
      light: "rgba(67, 75, 97, 0.06)",
      dark: "rgba(200, 210, 230, 0.06)",
    },
    success: {
      light: "#21c17b",
      dark: "#34d399",
    },
    successForeground: {
      light: "#ffffff",
      dark: "#064e3b",
    },
    error: {
      light: "#ff6f52",
      dark: "#ff8a72",
    },
    errorForeground: {
      light: "#ffffff",
      dark: "#451a03",
    },
    warning: {
      light: "#e5a126",
      dark: "#f0b944",
    },
    warningForeground: {
      light: "#ffffff",
      dark: "#451a03",
    },
    accent: {
      light: "#ff6f52",
      dark: "#ff8a72",
    },
    accentForeground: {
      light: "#ffffff",
      dark: "#451a03",
    },
  },
};

/**
 * Helper function to get a color value that can be either semantic or specific
 * @param value - Either a semantic color key or a specific color value/token
 * @param theme - Current theme for resolving semantic tokens
 * @returns Resolved color string
 */
export function getThemeColor(
  value: keyof CFTheme["colors"] | ColorToken | string,
  theme: CFTheme,
): string {
  const colorScheme = resolveColorScheme(theme.colorScheme);

  // If it's a semantic color key, resolve from theme
  if (typeof value === "string" && value in theme.colors) {
    const semanticToken = theme.colors[value as keyof CFTheme["colors"]];
    return resolveColor(semanticToken, colorScheme);
  }

  // If it's a color token object, resolve it
  if (
    typeof value === "object" && value !== null &&
    ("light" in value || "dark" in value)
  ) {
    return resolveColor(value as ColorToken, colorScheme);
  }

  // Otherwise, treat as specific color value
  return value as string;
}

/**
 * Helper function to get spacing that can be either semantic or specific
 * @param value - Either semantic spacing descriptor or specific value
 * @param theme - Current theme for resolving semantic spacing
 * @returns CSS spacing value
 */
export function getThemeSpacing(
  value:
    | `${keyof typeof BASE_SPACING}-${keyof typeof DENSITY_SCALES[
      CFTheme["density"]
    ]}`
    | string,
  theme: CFTheme,
): string {
  // If it's a semantic spacing descriptor (e.g., "lg-normal", "sm-tight")
  if (typeof value === "string" && value.includes("-")) {
    const [sizeStr, contextStr] = value.split("-") as [
      keyof typeof BASE_SPACING,
      keyof typeof DENSITY_SCALES[CFTheme["density"]],
    ];
    if (
      sizeStr in BASE_SPACING && contextStr in DENSITY_SCALES[theme.density]
    ) {
      return getSemanticSpacing(theme.density, sizeStr, contextStr);
    }
  }

  // Otherwise, treat as specific value
  return value;
}

/**
 * Create a theme override with granular control
 * @param baseTheme - Base theme to extend
 * @param overrides - Specific overrides (can use semantic values)
 * @returns New theme with applied overrides
 */
export function createThemeVariant(
  baseTheme: CFTheme,
  overrides: Partial<CFTheme> & {
    colors?: Partial<CFTheme["colors"]> & Record<string, ColorToken | string>;
  },
): CFTheme {
  return {
    ...baseTheme,
    ...overrides,
    colors: {
      ...baseTheme.colors,
      ...overrides.colors,
    },
  };
}

/**
 * Merge a partial theme with the default theme, supporting pattern-style partial objects
 * @param partialTheme - Partial theme object that may contain pattern-style properties
 * @param baseTheme - Base theme to merge with (defaults to defaultTheme)
 * @returns Full CFTheme with merged properties
 */
export function mergeWithDefaultTheme(
  partialTheme: any,
  baseTheme: CFTheme = defaultTheme,
): CFTheme {
  if (!partialTheme || typeof partialTheme !== "object") {
    return baseTheme;
  }

  // Handle pattern-style theme objects with specific properties
  const mergedTheme = { ...baseTheme };

  // Map common pattern theme properties to CFTheme properties
  if (partialTheme.accentColor) {
    mergedTheme.colors = {
      ...mergedTheme.colors,
      primary: partialTheme.accentColor,
      accent: partialTheme.accentColor,
    };
  }

  if (partialTheme.fontFace) {
    mergedTheme.fontFamily = partialTheme.fontFace;
  }

  if (partialTheme.borderRadius) {
    mergedTheme.borderRadius = partialTheme.borderRadius;
  }

  // Also handle direct CFTheme properties
  if (partialTheme.fontFamily) {
    mergedTheme.fontFamily = partialTheme.fontFamily;
  }

  if (partialTheme.monoFontFamily) {
    mergedTheme.monoFontFamily = partialTheme.monoFontFamily;
  }

  if (partialTheme.fontSize) {
    mergedTheme.fontSize = partialTheme.fontSize;
  }

  if (partialTheme.density) {
    mergedTheme.density = partialTheme.density;
  }

  if (partialTheme.colorScheme) {
    mergedTheme.colorScheme = partialTheme.colorScheme;
  }

  if (partialTheme.animationSpeed) {
    mergedTheme.animationSpeed = partialTheme.animationSpeed;
  }

  if (partialTheme.colors) {
    mergedTheme.colors = {
      ...mergedTheme.colors,
      ...partialTheme.colors,
    };
  }

  return mergedTheme;
}

/**
 * Get CSS animation duration based on theme animation speed
 * @param speed - Theme animation speed setting
 * @returns CSS duration value
 */
export function getAnimationDuration(speed: CFTheme["animationSpeed"]): string {
  switch (speed) {
    case "none":
      return "0ms";
    case "slow":
      return "500ms";
    case "normal":
      return "200ms";
    case "fast":
      return "100ms";
    default:
      return "200ms";
  }
}

/**
 * Apply theme properties to an element's style
 * @param element - Element to apply theme properties to
 * @param theme - Theme configuration
 * @param options - Additional options for customization
 */
export function applyThemeToElement(
  element: HTMLElement,
  theme: CFTheme,
  options: {
    includeSpacing?: boolean;
    includeColors?: boolean;
    includeTypography?: boolean;
    additionalSpacing?: Record<string, string>;
  } = {},
) {
  const {
    includeSpacing = true,
    includeColors = true,
    includeTypography = true,
    additionalSpacing = {},
  } = options;

  const colorScheme = resolveColorScheme(theme.colorScheme);

  // Typography and base properties
  if (includeTypography) {
    element.style.setProperty("--cf-theme-font-family", theme.fontFamily);
    element.style.setProperty("font-family", theme.fontFamily);
    element.style.setProperty(
      "--cf-theme-mono-font-family",
      theme.monoFontFamily,
    );
    element.style.setProperty("--cf-theme-font-size", theme.fontSize);
    element.style.setProperty("--cf-theme-border-radius", theme.borderRadius);
    element.style.setProperty(
      "--cf-theme-animation-duration",
      getAnimationDuration(theme.animationSpeed),
    );
  }

  // Colors - resolve all ColorTokens
  if (includeColors) {
    const colorMap = {
      "primary": theme.colors.primary,
      "primary-foreground": theme.colors.primaryForeground,
      "secondary": theme.colors.secondary,
      "secondary-foreground": theme.colors.secondaryForeground,
      "background": theme.colors.background,
      "surface": theme.colors.surface,
      "surface-hover": theme.colors.surfaceHover,
      "text": theme.colors.text,
      "text-muted": theme.colors.textMuted,
      "border": theme.colors.border,
      "border-muted": theme.colors.borderMuted,
      "success": theme.colors.success,
      "success-foreground": theme.colors.successForeground,
      "error": theme.colors.error,
      "error-foreground": theme.colors.errorForeground,
      "warning": theme.colors.warning,
      "warning-foreground": theme.colors.warningForeground,
      "accent": theme.colors.accent,
      "accent-foreground": theme.colors.accentForeground,
    };

    Object.entries(colorMap).forEach(([key, token]) => {
      element.style.setProperty(
        `--cf-theme-color-${key}`,
        resolveColor(token, colorScheme),
      );
    });
  }

  // Semantic spacing
  if (includeSpacing) {
    const spacingMap = {
      "tight": getSemanticSpacing(theme.density, "xs", "tight"),
      "normal": getSemanticSpacing(theme.density, "sm", "normal"),
      "loose": getSemanticSpacing(theme.density, "md", "loose"),
      "padding-message": getSemanticSpacing(theme.density, "lg", "normal"),
      "padding-code": getSemanticSpacing(theme.density, "sm", "tight"),
      "padding-block": getSemanticSpacing(theme.density, "md", "normal"),
      ...additionalSpacing,
    };

    Object.entries(spacingMap).forEach(([key, value]) => {
      element.style.setProperty(`--cf-theme-spacing-${key}`, value);
    });
  }
}

/**
 * Context for sharing theme across Common Fabric components
 */
export const cfThemeContext = createContext<CFTheme>("cf-theme");
