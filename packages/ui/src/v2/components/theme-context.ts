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
 * Comprehensive theme configuration for CT components
 */
export interface CTTheme {
  /** Font family for text content */
  fontFamily: string;
  /** Monospace font family for code */
  monoFontFamily: string;
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
  xs: 0.125,  // 2px at 16px base
  sm: 0.25,   // 4px
  md: 0.5,    // 8px  
  lg: 0.75,   // 12px
  xl: 1.0,    // 16px
  xxl: 1.5,   // 24px
} as const;

/**
 * Detect the current color scheme preference
 * @param scheme - Theme color scheme setting
 * @returns Resolved color scheme ("light" or "dark")
 */
export function resolveColorScheme(scheme: ColorScheme): "light" | "dark" {
  if (scheme === "auto") {
    // Check system preference
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
export function resolveColor(token: ColorToken, colorScheme: "light" | "dark"): string {
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
  density: CTTheme["density"],
  size: keyof typeof BASE_SPACING,
  context: "tight" | "normal" | "loose" = "normal"
): string {
  const scale = DENSITY_SCALES[density][context];
  const baseValue = BASE_SPACING[size];
  const scaledValue = baseValue * scale;
  
  // Map to closest ct-spacing level for compatibility
  const spacingLevel = Math.min(4, Math.round(scaledValue * 4));
  const fallback = `${scaledValue}rem`;
  
  return `var(--ct-spacing-${spacingLevel}, ${fallback})`;
}

/**
 * Default theme values with SwiftUI-style adaptive colors
 */
export const defaultTheme: CTTheme = {
  fontFamily: "system-ui, -apple-system, sans-serif",
  monoFontFamily: "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
  borderRadius: "0.5rem",
  density: "comfortable",
  colorScheme: "light",
  animationSpeed: "normal",
  colors: {
    primary: {
      light: "#3b82f6",
      dark: "#60a5fa"
    },
    primaryForeground: {
      light: "#ffffff",
      dark: "#1e3a8a"
    },
    secondary: {
      light: "#6b7280",
      dark: "#9ca3af"
    },
    secondaryForeground: {
      light: "#ffffff",
      dark: "#374151"
    },
    background: {
      light: "#ffffff",
      dark: "#0f172a"
    },
    surface: {
      light: "#f1f5f9",
      dark: "#1e293b"
    },
    surfaceHover: {
      light: "#e2e8f0",
      dark: "#334155"
    },
    text: {
      light: "#111827",
      dark: "#f1f5f9"
    },
    textMuted: {
      light: "#6b7280",
      dark: "#94a3b8"
    },
    border: {
      light: "#e5e7eb",
      dark: "#475569"
    },
    borderMuted: {
      light: "#f3f4f6",
      dark: "#334155"
    },
    success: {
      light: "#16a34a",
      dark: "#22c55e"
    },
    successForeground: {
      light: "#ffffff",
      dark: "#14532d"
    },
    error: {
      light: "#dc2626",
      dark: "#ef4444"
    },
    errorForeground: {
      light: "#ffffff",
      dark: "#7f1d1d"
    },
    warning: {
      light: "#d97706",
      dark: "#f59e0b"
    },
    warningForeground: {
      light: "#ffffff",
      dark: "#451a03"
    },
    accent: {
      light: "#8b5cf6",
      dark: "#a78bfa"
    },
    accentForeground: {
      light: "#ffffff",
      dark: "#4c1d95"
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
  value: keyof CTTheme["colors"] | ColorToken | string,
  theme: CTTheme
): string {
  const colorScheme = resolveColorScheme(theme.colorScheme);
  
  // If it's a semantic color key, resolve from theme
  if (typeof value === "string" && value in theme.colors) {
    const semanticToken = theme.colors[value as keyof CTTheme["colors"]];
    return resolveColor(semanticToken, colorScheme);
  }
  
  // If it's a color token object, resolve it
  if (typeof value === "object" && value !== null && ("light" in value || "dark" in value)) {
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
  value: `${keyof typeof BASE_SPACING}-${keyof typeof DENSITY_SCALES[CTTheme["density"]]}` | string,
  theme: CTTheme
): string {
  // If it's a semantic spacing descriptor (e.g., "lg-normal", "sm-tight")
  if (typeof value === "string" && value.includes("-")) {
    const [sizeStr, contextStr] = value.split("-") as [keyof typeof BASE_SPACING, keyof typeof DENSITY_SCALES[CTTheme["density"]]];
    if (sizeStr in BASE_SPACING && contextStr in DENSITY_SCALES[theme.density]) {
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
  baseTheme: CTTheme,
  overrides: Partial<CTTheme> & {
    colors?: Partial<CTTheme["colors"]> & Record<string, ColorToken | string>;
  }
): CTTheme {
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
 * Get CSS animation duration based on theme animation speed
 * @param speed - Theme animation speed setting
 * @returns CSS duration value
 */
export function getAnimationDuration(speed: CTTheme["animationSpeed"]): string {
  switch (speed) {
    case "none": return "0ms";
    case "slow": return "500ms";
    case "normal": return "200ms";
    case "fast": return "100ms";
    default: return "200ms";
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
  theme: CTTheme,
  options: {
    includeSpacing?: boolean;
    includeColors?: boolean;
    includeTypography?: boolean;
    additionalSpacing?: Record<string, string>;
  } = {}
) {
  const {
    includeSpacing = true,
    includeColors = true,
    includeTypography = true,
    additionalSpacing = {}
  } = options;

  const colorScheme = resolveColorScheme(theme.colorScheme);

  // Typography and base properties
  if (includeTypography) {
    element.style.setProperty("--ct-theme-font-family", theme.fontFamily);
    element.style.setProperty("--ct-theme-mono-font-family", theme.monoFontFamily);
    element.style.setProperty("--ct-theme-border-radius", theme.borderRadius);
    element.style.setProperty("--ct-theme-animation-duration", getAnimationDuration(theme.animationSpeed));
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
      element.style.setProperty(`--ct-theme-color-${key}`, resolveColor(token, colorScheme));
    });
  }

  // Semantic spacing
  if (includeSpacing) {
    const spacingMap = {
      "tight": getSemanticSpacing(theme.density, 'xs', 'tight'),
      "normal": getSemanticSpacing(theme.density, 'sm', 'normal'),
      "loose": getSemanticSpacing(theme.density, 'md', 'loose'),
      "padding-message": getSemanticSpacing(theme.density, 'lg', 'normal'),
      "padding-code": getSemanticSpacing(theme.density, 'sm', 'tight'),
      "padding-block": getSemanticSpacing(theme.density, 'md', 'normal'),
      ...additionalSpacing
    };

    Object.entries(spacingMap).forEach(([key, value]) => {
      element.style.setProperty(`--ct-theme-spacing-${key}`, value);
    });
  }
}

/**
 * Context for sharing theme across CT components
 */
export const themeContext = createContext<CTTheme>("ct-theme");