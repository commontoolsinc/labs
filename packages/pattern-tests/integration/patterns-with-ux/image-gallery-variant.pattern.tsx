/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface VariantInput {
  mode?: string;
  src?: string;
  alt?: string;
}

interface VariantDetails {
  mode: string;
  src: string;
  alt: string;
}

type VariantMap = Record<string, VariantDetails>;

const DEFAULT_MODES: string[] = ["mobile", "tablet", "desktop"];

const sanitizeMode = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
};

const defaultVariantForMode = (mode: string): VariantDetails => ({
  mode,
  src: `${mode}-placeholder.png`,
  alt: `Image for ${mode}`,
});

const sanitizeModes = (value: unknown): string[] => {
  const fallback = [...DEFAULT_MODES].sort((a, b) => a.localeCompare(b));
  if (!Array.isArray(value)) return fallback;
  const collected = new Set<string>();
  for (const entry of value) {
    const mode = sanitizeMode(entry);
    if (mode) collected.add(mode);
  }
  const result = [...collected].sort((a, b) => a.localeCompare(b));
  return result.length > 0 ? result : fallback;
};

const sanitizeSource = (
  value: unknown,
  fallback: string,
  mode: string,
): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback.length > 0 ? fallback : defaultVariantForMode(mode).src;
};

const sanitizeAlt = (
  value: unknown,
  fallback: string,
  mode: string,
): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback.length > 0 ? fallback : defaultVariantForMode(mode).alt;
};

const sanitizeVariants = (
  entries: unknown,
  modeList: string[],
): VariantMap => {
  const base: VariantMap = {};
  for (const mode of modeList) {
    base[mode] = { ...defaultVariantForMode(mode) };
  }
  if (!Array.isArray(entries)) return base;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as VariantInput;
    const mode = sanitizeMode(record.mode);
    if (!mode || !modeList.includes(mode)) continue;
    const fallback = base[mode];
    const src = sanitizeSource(record.src, fallback.src, mode);
    const alt = sanitizeAlt(record.alt, fallback.alt, mode);
    base[mode] = { mode, src, alt };
  }
  return base;
};

interface ImageGalleryVariantArgs {
  modes: Default<string[], typeof DEFAULT_MODES>;
  variants: Default<VariantInput[], []>;
  activeMode: Default<string, "desktop">;
}

const selectDeviceMode = handler(
  (
    event: { mode?: string } | undefined,
    context: {
      activeMode: Cell<string>;
      modes: Cell<unknown>;
      history: Cell<string[]>;
    },
  ) => {
    const modes = sanitizeModes(context.modes.get());
    if (modes.length === 0) return;
    const requested = sanitizeMode(event?.mode);
    const next = requested && modes.includes(requested) ? requested : modes[0];
    context.activeMode.set(next);
    const currentHistory = Array.isArray(context.history.get())
      ? context.history.get()
      : [];
    context.history.set([...currentHistory, next]);
  },
);

const updateDeviceVariant = handler(
  (
    event: { mode?: string; src?: string; alt?: string } | undefined,
    context: {
      variants: Cell<VariantInput[]>;
      modes: Cell<unknown>;
    },
  ) => {
    const modes = sanitizeModes(context.modes.get());
    if (modes.length === 0) return;
    const mode = sanitizeMode(event?.mode) ?? modes[0];
    if (!modes.includes(mode)) return;
    const existing = Array.isArray(context.variants.get())
      ? context.variants.get()
      : [];
    const sanitized = sanitizeVariants(existing, modes);
    const current = sanitized[mode] ?? defaultVariantForMode(mode);
    const src = sanitizeSource(event?.src, current.src, mode);
    const alt = sanitizeAlt(event?.alt, current.alt, mode);
    sanitized[mode] = { mode, src, alt };
    const nextList = modes.map((entry) => ({ ...sanitized[entry] }));
    context.variants.set(nextList);
  },
);

export const imageGalleryVariantUx = recipe<ImageGalleryVariantArgs>(
  "Image Gallery Variant (UX)",
  ({ modes, variants, activeMode }) => {
    const selectionHistory = cell<string[]>([]);

    const sanitizedModes = lift((value: unknown) => sanitizeModes(value))(
      modes,
    );

    const sanitizedVariants = lift((input: {
      entries: VariantInput[] | undefined;
      modeList: string[];
    }) => sanitizeVariants(input.entries, input.modeList))({
      entries: variants,
      modeList: sanitizedModes,
    });

    const selectedMode = lift((input: {
      candidate: string | undefined;
      modes: string[];
    }) => {
      const list = input.modes;
      if (list.length === 0) return "desktop";
      const mode = sanitizeMode(input.candidate);
      return mode && list.includes(mode) ? mode : list[0];
    })({ candidate: activeMode, modes: sanitizedModes });

    const currentVariant = lift((input: {
      variants: VariantMap;
      mode: string;
      modes: string[];
    }) => {
      const list = input.modes;
      if (list.length === 0) return defaultVariantForMode("desktop");
      const target = input.variants[input.mode];
      if (target) return { ...target };
      const fallback = list[0];
      return { ...input.variants[fallback] };
    })({
      variants: sanitizedVariants,
      mode: selectedMode,
      modes: sanitizedModes,
    });

    const currentSource = lift((variant: VariantDetails) => variant.src)(
      currentVariant,
    );
    const currentAlt = lift((variant: VariantDetails) => variant.alt)(
      currentVariant,
    );

    const historyView = lift((value: string[] | undefined) =>
      Array.isArray(value) ? value : []
    )(selectionHistory);

    // UI handlers
    const modeInputField = cell<string>("");
    const srcInputField = cell<string>("");
    const altInputField = cell<string>("");

    const uiSelectMode = handler<
      unknown,
      {
        modeField: Cell<string>;
        activeMode: Cell<string>;
        modes: Cell<unknown>;
        history: Cell<string[]>;
      }
    >((_event, { modeField, activeMode, modes, history }) => {
      const modeStr = modeField.get();
      const modeList = sanitizeModes(modes.get());
      if (modeList.length === 0) return;
      const requested = sanitizeMode(modeStr);
      const next = requested && modeList.includes(requested)
        ? requested
        : modeList[0];
      activeMode.set(next);
      const currentHistory = Array.isArray(history.get()) ? history.get() : [];
      history.set([...currentHistory, next]);
      modeField.set("");
    });

    const uiUpdateVariant = handler<
      unknown,
      {
        modeField: Cell<string>;
        srcField: Cell<string>;
        altField: Cell<string>;
        variants: Cell<VariantInput[]>;
        modes: Cell<unknown>;
      }
    >((_event, { modeField, srcField, altField, variants, modes }) => {
      const modeStr = modeField.get();
      const srcStr = srcField.get();
      const altStr = altField.get();

      const modeList = sanitizeModes(modes.get());
      if (modeList.length === 0) return;
      const mode = sanitizeMode(modeStr) ?? modeList[0];
      if (!modeList.includes(mode)) return;
      const existing = Array.isArray(variants.get()) ? variants.get() : [];
      const sanitized = sanitizeVariants(existing, modeList);
      const current = sanitized[mode] ?? defaultVariantForMode(mode);
      const src = sanitizeSource(srcStr, current.src, mode);
      const alt = sanitizeAlt(altStr, current.alt, mode);
      sanitized[mode] = { mode, src, alt };
      const nextList = modeList.map((entry) => ({ ...sanitized[entry] }));
      variants.set(nextList);

      modeField.set("");
      srcField.set("");
      altField.set("");
    });

    const selectModeAction = uiSelectMode({
      modeField: modeInputField,
      activeMode,
      modes,
      history: selectionHistory,
    });

    const updateVariantAction = uiUpdateVariant({
      modeField: modeInputField,
      srcField: srcInputField,
      altField: altInputField,
      variants,
      modes,
    });

    const variantCards = lift((input: {
      variants: VariantMap;
      modes: string[];
      selected: string;
    }) => {
      const cards = [];
      const variants = input.variants;
      const modes = input.modes;
      const selected = input.selected;

      for (const mode of modes) {
        const variant = variants[mode];
        if (!variant) continue;

        const isActive = mode === selected;
        const borderColor = isActive ? "#3b82f6" : "#e5e7eb";
        const bgColor = isActive ? "#eff6ff" : "#ffffff";
        const cardStyle = "border: 2px solid " + borderColor + "; " +
          "background: " + bgColor + "; " +
          "border-radius: 8px; padding: 16px; transition: all 0.2s;";

        const modeStyle = "font-weight: 600; font-size: 14px; " +
          "color: #1f2937; text-transform: capitalize; margin-bottom: 12px;";

        const imgStyle = "width: 100%; height: 200px; " +
          "background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); " +
          "border-radius: 6px; display: flex; align-items: center; " +
          "justify-content: center; color: white; font-size: 14px; " +
          "margin-bottom: 12px; overflow: hidden;";

        const labelStyle = "font-size: 12px; color: #6b7280; " +
          "margin-bottom: 4px; font-weight: 500;";
        const valueStyle = "font-size: 13px; color: #374151; " +
          "font-family: monospace; word-break: break-all;";

        const badge = isActive
          ? h(
            "div",
            {
              style: "display: inline-block; background: #3b82f6; " +
                "color: white; font-size: 10px; font-weight: 600; " +
                "padding: 4px 8px; border-radius: 4px; margin-left: 8px;",
            },
            "ACTIVE",
          )
          : null;

        cards.push(
          h(
            "div",
            { style: cardStyle },
            h(
              "div",
              { style: modeStyle },
              mode.toUpperCase(),
              badge,
            ),
            h(
              "div",
              { style: imgStyle },
              "[Image Preview]",
            ),
            h("div", { style: labelStyle }, "Source:"),
            h(
              "div",
              { style: valueStyle + " margin-bottom: 8px;" },
              variant.src,
            ),
            h("div", { style: labelStyle }, "Alt Text:"),
            h("div", { style: valueStyle }, variant.alt),
          ),
        );
      }

      return h(
        "div",
        {
          style:
            "display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); " +
            "gap: 16px;",
        },
        ...cards,
      );
    })({
      variants: sanitizedVariants,
      modes: sanitizedModes,
      selected: selectedMode,
    });

    const recentHistory = lift((history: string[]) => {
      if (!Array.isArray(history) || history.length === 0) {
        return "None yet";
      }
      const recent = history.slice(-5).reverse();
      return recent.join(" → ");
    })(historyView);

    const name = lift((mode: string) => `Image Gallery (${mode})`)(
      selectedMode,
    );

    const ui = (
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 1200px; margin: 0 auto; padding: 24px; background: #f9fafb;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 24px; border-radius: 12px; margin-bottom: 24px;">
          <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">
            📱 Responsive Image Gallery
          </h1>
          <div style="font-size: 14px; opacity: 0.95;">
            Manage device-specific image variants with preview
          </div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px;">
          <div style="background: white; padding: 20px; border-radius: 10px; border: 1px solid #e5e7eb;">
            <div style="font-weight: 600; font-size: 16px; color: #1f2937; margin-bottom: 4px;">
              Active Mode
            </div>
            <div style="font-size: 24px; font-weight: 700; color: #3b82f6; text-transform: uppercase;">
              {selectedMode}
            </div>
          </div>

          <div style="background: white; padding: 20px; border-radius: 10px; border: 1px solid #e5e7eb;">
            <div style="font-weight: 600; font-size: 16px; color: #1f2937; margin-bottom: 4px;">
              Recent Selections
            </div>
            <div style="font-size: 13px; color: #6b7280; font-family: monospace;">
              {recentHistory}
            </div>
          </div>
        </div>

        <div style="background: white; padding: 20px; border-radius: 10px; border: 1px solid #e5e7eb; margin-bottom: 24px;">
          <h2 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #1f2937;">
            🎯 Switch Mode
          </h2>
          <div style="display: grid; gap: 12px;">
            <ct-input
              $value={modeInputField}
              placeholder="Enter mode (mobile, tablet, desktop)"
              style="padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;"
            />
            <ct-button
              onClick={selectModeAction}
              style="padding: 10px 16px; background: #3b82f6; color: white; border: none; border-radius: 6px; font-weight: 500; cursor: pointer;"
            >
              Switch Mode
            </ct-button>
          </div>
        </div>

        <div style="background: white; padding: 20px; border-radius: 10px; border: 1px solid #e5e7eb; margin-bottom: 24px;">
          <h2 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #1f2937;">
            ✏️ Update Variant
          </h2>
          <div style="display: grid; gap: 12px;">
            <div>
              <div style="font-size: 12px; color: #6b7280; margin-bottom: 4px; font-weight: 500;">
                Mode
              </div>
              <ct-input
                $value={modeInputField}
                placeholder="mobile, tablet, or desktop"
                style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;"
              />
            </div>
            <div>
              <div style="font-size: 12px; color: #6b7280; margin-bottom: 4px; font-weight: 500;">
                Image Source URL
              </div>
              <ct-input
                $value={srcInputField}
                placeholder="https://example.com/image.jpg"
                style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;"
              />
            </div>
            <div>
              <div style="font-size: 12px; color: #6b7280; margin-bottom: 4px; font-weight: 500;">
                Alt Text
              </div>
              <ct-input
                $value={altInputField}
                placeholder="Descriptive text for the image"
                style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;"
              />
            </div>
            <ct-button
              onClick={updateVariantAction}
              style="padding: 10px 16px; background: #8b5cf6; color: white; border: none; border-radius: 6px; font-weight: 500; cursor: pointer;"
            >
              Update Variant
            </ct-button>
          </div>
        </div>

        <div style="background: white; padding: 20px; border-radius: 10px; border: 1px solid #e5e7eb;">
          <h2 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #1f2937;">
            🖼️ Image Variants
          </h2>
          {variantCards}
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      availableModes: sanitizedModes,
      variantMap: sanitizedVariants,
      activeMode: selectedMode,
      currentVariant,
      currentSource,
      currentAlt,
      label: str`Mode ${selectedMode} uses ${currentSource}`,
      history: historyView,
      selectMode: selectDeviceMode({
        activeMode,
        modes,
        history: selectionHistory,
      }),
      updateVariant: updateDeviceVariant({ variants, modes }),
    };
  },
);
