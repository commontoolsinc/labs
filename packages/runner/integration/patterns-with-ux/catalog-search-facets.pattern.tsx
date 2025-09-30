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

interface CatalogItemInput {
  id?: string;
  title?: string;
  category?: string;
  brand?: string;
  price?: number;
  tags?: unknown;
}

interface CatalogItem {
  id: string;
  title: string;
  category: string;
  brand: string;
  price: number;
  tags: string[];
}

interface FacetSelection {
  categories: string[];
  brands: string[];
  priceCeiling: number | null;
}

interface PriceRange {
  min: number;
  max: number;
  average: number;
}

interface CatalogSearchArgs {
  catalog: Default<CatalogItemInput[], typeof defaultCatalog>;
}

const defaultCatalog: CatalogItem[] = [
  {
    id: "french-press",
    title: "Stainless Steel French Press",
    category: "Kitchen",
    brand: "Brew Pro",
    price: 48.5,
    tags: ["coffee", "brewing"],
  },
  {
    id: "pour-over-kit",
    title: "Pour Over Coffee Kit",
    category: "Kitchen",
    brand: "Daily Bean",
    price: 38,
    tags: ["coffee", "manual"],
  },
  {
    id: "hiking-pack",
    title: "Lightweight Hiking Backpack",
    category: "Outdoors",
    brand: "Trailhead",
    price: 96,
    tags: ["gear", "trail"],
  },
  {
    id: "trail-shoes",
    title: "Trail Running Shoes",
    category: "Outdoors",
    brand: "Trailhead",
    price: 120,
    tags: ["shoes", "running"],
  },
  {
    id: "noise-cancelling-headphones",
    title: "Noise Cancelling Headphones",
    category: "Electronics",
    brand: "Sonic Pulse",
    price: 180,
    tags: ["audio", "travel"],
  },
  {
    id: "smart-speaker",
    title: "Smart Home Speaker",
    category: "Electronics",
    brand: "Sonic Pulse",
    price: 140,
    tags: ["audio", "home"],
  },
];

const defaultSelection: FacetSelection = {
  categories: [],
  brands: [],
  priceCeiling: null,
};

const toTitleCase = (value: string): string =>
  value.split(/\s+/).filter((part) => part.length > 0).map((part) => {
    const head = part.charAt(0).toUpperCase();
    const rest = part.slice(1).toLowerCase();
    return `${head}${rest}`;
  }).join(" ");

const sanitizeString = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeFacet = (value: unknown, fallback: string): string => {
  const base = sanitizeString(value, fallback);
  if (base.length === 0) return fallback;
  return toTitleCase(base);
};

const sanitizePrice = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.round(value * 100) / 100;
    if (normalized >= 0) return normalized;
  }
  return fallback;
};

const sanitizeTags = (value: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  tags.sort((left, right) => left.localeCompare(right));
  return tags;
};

const normalizeId = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "").replace(/-+$/, "");

const ensureUniqueId = (candidate: string, used: Set<string>): string => {
  let base = candidate.length > 0 ? candidate : "item";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  const unique = `${base}-${suffix}`;
  used.add(unique);
  return unique;
};

const sanitizeCatalog = (value: unknown): CatalogItem[] => {
  const entries = Array.isArray(value) && value.length > 0
    ? (value as CatalogItemInput[])
    : defaultCatalog;
  const sanitized: CatalogItem[] = [];
  const used = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const raw = entries[index] ?? {};
    const fallback = defaultCatalog[index % defaultCatalog.length];
    const title = sanitizeString(raw.title, fallback.title);
    const category = sanitizeFacet(raw.category, fallback.category);
    const brand = sanitizeFacet(raw.brand, fallback.brand);
    const price = sanitizePrice(raw.price, fallback.price);
    const tags = sanitizeTags(raw.tags, fallback.tags);
    const idSource = typeof raw.id === "string"
      ? raw.id
      : typeof raw.title === "string"
      ? raw.title
      : fallback.id;
    const normalized = normalizeId(idSource);
    const fallbackId = normalizeId(fallback.id);
    const id = ensureUniqueId(
      normalized.length > 0 ? normalized : fallbackId,
      used,
    );
    sanitized.push({ id, title, category, brand, price, tags });
  }
  sanitized.sort((left, right) => left.title.localeCompare(right.title));
  return sanitized;
};

const computeAvailableCategories = (
  items: readonly CatalogItem[],
): string[] => {
  const unique = new Set<string>();
  for (const item of items) unique.add(item.category);
  return Array.from(unique).sort((left, right) => left.localeCompare(right));
};

const computeAvailableBrands = (
  items: readonly CatalogItem[],
): string[] => {
  const unique = new Set<string>();
  for (const item of items) unique.add(item.brand);
  return Array.from(unique).sort((left, right) => left.localeCompare(right));
};

const computePriceRange = (items: readonly CatalogItem[]): PriceRange => {
  if (items.length === 0) {
    return { min: 0, max: 0, average: 0 };
  }
  let total = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    total += item.price;
    if (item.price < min) min = item.price;
    if (item.price > max) max = item.price;
  }
  const average = Math.round((total / items.length) * 100) / 100;
  return {
    min: Math.round(min * 100) / 100,
    max: Math.round(max * 100) / 100,
    average,
  };
};

const filterItems = (input: {
  items: readonly CatalogItem[];
  categories: readonly string[];
  brands: readonly string[];
  priceCeiling: number | null;
}): CatalogItem[] => {
  const sourceItems = Array.isArray(input.items) ? input.items : [];
  const categories = Array.isArray(input.categories) ? input.categories : [];
  const brands = Array.isArray(input.brands) ? input.brands : [];
  const ceiling = typeof input.priceCeiling === "number" &&
      Number.isFinite(input.priceCeiling)
    ? input.priceCeiling
    : null;
  const categorySet = new Set(categories);
  const brandSet = new Set(brands);
  return sourceItems.filter((item) => {
    const matchesCategory = categorySet.size === 0 ||
      categorySet.has(item.category);
    const matchesBrand = brandSet.size === 0 || brandSet.has(item.brand);
    const matchesPrice = ceiling === null || item.price <= ceiling;
    return matchesCategory && matchesBrand && matchesPrice;
  });
};

const formatPrice = (value: number): string => `$${value.toFixed(2)}`;

const summarizeSelection = (
  categories: readonly string[],
  brands: readonly string[],
  priceCeiling: number | null,
): string => {
  const parts: string[] = [];
  parts.push(
    categories.length > 0
      ? `Categories: ${categories.join(", ")}`
      : "Categories: All",
  );
  parts.push(
    brands.length > 0 ? `Brands: ${brands.join(", ")}` : "Brands: All",
  );
  const hasCeiling = typeof priceCeiling === "number" &&
    Number.isFinite(priceCeiling);
  parts.push(
    hasCeiling ? `Price ≤ ${formatPrice(priceCeiling)}` : "Price ≤ Any",
  );
  return parts.join(" • ");
};

const toggleFacet = handler(
  (
    event: { value?: string } | undefined,
    context: { target: Cell<string[]> },
  ) => {
    const normalized = sanitizeFacet(event?.value, "");
    if (normalized.length === 0) return;
    const current = context.target.get();
    const next = current.slice();
    const index = next.indexOf(normalized);
    if (index >= 0) {
      next.splice(index, 1);
    } else {
      next.push(normalized);
      next.sort((left, right) => left.localeCompare(right));
    }
    context.target.set(next);
  },
);

const setPriceCeiling = handler(
  (
    event:
      | { ceiling?: number | null }
      | undefined,
    context: { price: Cell<number | null>; range: Cell<PriceRange> },
  ) => {
    if (event?.ceiling === null) {
      context.price.set(null);
      return;
    }
    if (typeof event?.ceiling !== "number" || !Number.isFinite(event.ceiling)) {
      context.price.set(null);
      return;
    }
    const sanitized = Math.max(0, Math.round(event.ceiling * 100) / 100);
    const range = context.range.get();
    if (range.max <= 0) {
      context.price.set(null);
      return;
    }
    const clamped = Math.min(sanitized, range.max);
    context.price.set(clamped);
  },
);

const clearFilters = handler(
  (_event: unknown, context: {
    categories: Cell<string[]>;
    brands: Cell<string[]>;
    price: Cell<number | null>;
  }) => {
    context.categories.set([...defaultSelection.categories]);
    context.brands.set([...defaultSelection.brands]);
    context.price.set(defaultSelection.priceCeiling);
  },
);

export const catalogSearchFacets = recipe<CatalogSearchArgs>(
  "Catalog Search Facets",
  ({ catalog }) => {
    const sanitizedCatalog = lift(sanitizeCatalog)(catalog);

    const selectedCategories = cell<string[]>(
      structuredClone(defaultSelection.categories),
    );
    const selectedBrands = cell<string[]>(
      structuredClone(defaultSelection.brands),
    );
    const priceCeiling = cell<number | null>(defaultSelection.priceCeiling);

    const availableCategories = lift(computeAvailableCategories)(
      sanitizedCatalog,
    );
    const availableBrands = lift(computeAvailableBrands)(sanitizedCatalog);
    const priceRange = lift(computePriceRange)(sanitizedCatalog);

    const filteredItems = lift(filterItems)({
      items: sanitizedCatalog,
      categories: selectedCategories,
      brands: selectedBrands,
      priceCeiling,
    });

    const totalCount = lift((items: CatalogItem[]) => items.length)(
      sanitizedCatalog,
    );
    const filteredCount = lift((items: CatalogItem[]) => items.length)(
      filteredItems,
    );

    const selectionSummary = lift((input: {
      categories: string[];
      brands: string[];
      price: number | null;
    }) => summarizeSelection(input.categories, input.brands, input.price))({
      categories: selectedCategories,
      brands: selectedBrands,
      price: priceCeiling,
    });

    const statusLabel = str`Showing ${filteredCount} of ${totalCount} products`;

    const name = str`Catalog Search (${filteredCount}/${totalCount})`;

    const priceInputCell = cell<string>("");

    const hasActiveFilters = lift((input: {
      categories: string[];
      brands: string[];
      price: number | null;
    }) => {
      return input.categories.length > 0 || input.brands.length > 0 ||
        input.price !== null;
    })({
      categories: selectedCategories,
      brands: selectedBrands,
      price: priceCeiling,
    });

    const categoryInputCell = cell<string>("");

    const toggleCategoryFromInput = handler(
      (
        _event: unknown,
        context: { input: Cell<string>; target: Cell<string[]> },
      ) => {
        const value = context.input.get();
        const normalized = sanitizeFacet(value, "");
        if (normalized.length === 0) return;
        const current = context.target.get();
        const next = current.slice();
        const index = next.indexOf(normalized);
        if (index >= 0) {
          next.splice(index, 1);
        } else {
          next.push(normalized);
          next.sort((left, right) => left.localeCompare(right));
        }
        context.target.set(next);
        context.input.set("");
      },
    );

    const categoryButtons = lift((input: {
      available: string[];
      selected: string[];
    }) => {
      const elements = [];
      for (const category of input.available) {
        const isSelected = input.selected.indexOf(category) >= 0;
        const badgeStyle = isSelected
          ? "background: #10b981; color: white; border: 2px solid #059669; " +
            "padding: 8px 16px; border-radius: 6px; font-weight: 500; " +
            "display: inline-block;"
          : "background: white; color: #374151; border: 2px solid #d1d5db; " +
            "padding: 8px 16px; border-radius: 6px; display: inline-block;";
        elements.push(
          h(
            "span",
            { style: badgeStyle },
            category + (isSelected ? " ✓" : ""),
          ),
        );
      }
      return h(
        "div",
        { style: "display: flex; gap: 8px; flex-wrap: wrap;" },
        ...elements,
      );
    })({
      available: availableCategories,
      selected: selectedCategories,
    });

    const brandInputCell = cell<string>("");

    const toggleBrandFromInput = handler(
      (
        _event: unknown,
        context: { input: Cell<string>; target: Cell<string[]> },
      ) => {
        const value = context.input.get();
        const normalized = sanitizeFacet(value, "");
        if (normalized.length === 0) return;
        const current = context.target.get();
        const next = current.slice();
        const index = next.indexOf(normalized);
        if (index >= 0) {
          next.splice(index, 1);
        } else {
          next.push(normalized);
          next.sort((left, right) => left.localeCompare(right));
        }
        context.target.set(next);
        context.input.set("");
      },
    );

    const brandButtons = lift((input: {
      available: string[];
      selected: string[];
    }) => {
      const elements = [];
      for (const brand of input.available) {
        const isSelected = input.selected.indexOf(brand) >= 0;
        const badgeStyle = isSelected
          ? "background: #8b5cf6; color: white; border: 2px solid #7c3aed; " +
            "padding: 8px 16px; border-radius: 6px; font-weight: 500; " +
            "display: inline-block;"
          : "background: white; color: #374151; border: 2px solid #d1d5db; " +
            "padding: 8px 16px; border-radius: 6px; display: inline-block;";
        elements.push(
          h(
            "span",
            { style: badgeStyle },
            brand + (isSelected ? " ✓" : ""),
          ),
        );
      }
      return h(
        "div",
        { style: "display: flex; gap: 8px; flex-wrap: wrap;" },
        ...elements,
      );
    })({
      available: availableBrands,
      selected: selectedBrands,
    });

    const updatePriceInput = handler(
      (
        _event: unknown,
        context: {
          input: Cell<string>;
          price: Cell<number | null>;
          range: Cell<PriceRange>;
        },
      ) => {
        const inputValue = context.input.get();
        const parsed = parseFloat(inputValue);
        if (
          typeof inputValue === "string" && inputValue.trim() === ""
        ) {
          context.price.set(null);
          return;
        }
        if (!Number.isFinite(parsed) || parsed < 0) {
          return;
        }
        const sanitized = Math.max(0, Math.round(parsed * 100) / 100);
        const range = context.range.get();
        if (range.max <= 0) {
          context.price.set(null);
          return;
        }
        const clamped = Math.min(sanitized, range.max);
        context.price.set(clamped);
      },
    );

    const clearPriceFilter = handler(
      (
        _event: unknown,
        context: { price: Cell<number | null>; input: Cell<string> },
      ) => {
        context.price.set(null);
        context.input.set("");
      },
    );

    const priceDisplay = lift(
      (price: number | null) => price === null ? "Any" : formatPrice(price),
    )(priceCeiling);

    const productCards = lift((items: CatalogItem[]) => {
      if (items.length === 0) {
        return h(
          "div",
          {
            style: "padding: 32px; text-align: center; color: #6b7280; " +
              "background: #f9fafb; border-radius: 8px; border: 2px dashed #d1d5db;",
          },
          "No products match your filters",
        );
      }
      const cards = [];
      for (const item of items) {
        const priceStr = formatPrice(item.price);
        const tagsStr = item.tags.join(", ");
        cards.push(
          h(
            "ct-card",
            {
              style: "padding: 16px; border: 1px solid #e5e7eb; " +
                "border-radius: 8px; background: white;",
            },
            h(
              "div",
              { style: "display: flex; flex-direction: column; gap: 8px;" },
              h(
                "div",
                { style: "font-weight: 600; font-size: 16px; color: #111827;" },
                item.title,
              ),
              h(
                "div",
                { style: "display: flex; gap: 12px; font-size: 14px;" },
                h(
                  "span",
                  {
                    style:
                      "background: #dbeafe; color: #1e40af; padding: 4px 8px; " +
                      "border-radius: 4px; font-weight: 500;",
                  },
                  item.category,
                ),
                h(
                  "span",
                  {
                    style:
                      "background: #f3e8ff; color: #6b21a8; padding: 4px 8px; " +
                      "border-radius: 4px; font-weight: 500;",
                  },
                  item.brand,
                ),
              ),
              h(
                "div",
                {
                  style: "font-size: 20px; font-weight: 700; color: #059669; " +
                    "margin-top: 4px;",
                },
                priceStr,
              ),
              h(
                "div",
                {
                  style: "font-size: 12px; color: #6b7280; font-style: italic;",
                },
                tagsStr,
              ),
            ),
          ),
        );
      }
      return h(
        "div",
        {
          style: "display: grid; grid-template-columns: " +
            "repeat(auto-fill, minmax(280px, 1fr)); gap: 16px;",
        },
        ...cards,
      );
    })(filteredItems);

    const ui = (
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 1200px; margin: 0 auto; padding: 24px;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 24px; border-radius: 12px; margin-bottom: 24px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">
            Product Catalog
          </h1>
          <div style="font-size: 18px; opacity: 0.95;">{statusLabel}</div>
        </div>

        <ct-card style="padding: 20px; margin-bottom: 24px; background: white; border-radius: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
          <div style="display: flex; flex-direction: column; gap: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <h2 style="margin: 0; font-size: 20px; font-weight: 600; color: #111827;">
                Filters
              </h2>
              <ct-button
                onClick={clearFilters({
                  categories: selectedCategories,
                  brands: selectedBrands,
                  price: priceCeiling,
                })}
                disabled={lift((active: boolean) => !active)(hasActiveFilters)}
                style="background: #ef4444; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500;"
              >
                Clear All
              </ct-button>
            </div>

            <div>
              <div style="font-weight: 600; color: #374151; margin-bottom: 10px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">
                Categories
              </div>
              {categoryButtons}
              <div style="display: flex; gap: 8px; margin-top: 12px;">
                <ct-input
                  $value={categoryInputCell}
                  placeholder="Enter category name to toggle"
                  style="flex: 1; padding: 8px 12px; border: 2px solid #d1d5db; border-radius: 6px; font-size: 14px;"
                />
                <ct-button
                  onClick={toggleCategoryFromInput({
                    input: categoryInputCell,
                    target: selectedCategories,
                  })}
                  style="background: #10b981; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; white-space: nowrap;"
                >
                  Toggle
                </ct-button>
              </div>
            </div>

            <div>
              <div style="font-weight: 600; color: #374151; margin-bottom: 10px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">
                Brands
              </div>
              {brandButtons}
              <div style="display: flex; gap: 8px; margin-top: 12px;">
                <ct-input
                  $value={brandInputCell}
                  placeholder="Enter brand name to toggle"
                  style="flex: 1; padding: 8px 12px; border: 2px solid #d1d5db; border-radius: 6px; font-size: 14px;"
                />
                <ct-button
                  onClick={toggleBrandFromInput({
                    input: brandInputCell,
                    target: selectedBrands,
                  })}
                  style="background: #8b5cf6; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; white-space: nowrap;"
                >
                  Toggle
                </ct-button>
              </div>
            </div>

            <div>
              <div style="font-weight: 600; color: #374151; margin-bottom: 10px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">
                Maximum Price: {priceDisplay}
              </div>
              <div style="display: flex; gap: 8px; align-items: center;">
                <ct-input
                  $value={priceInputCell}
                  type="number"
                  placeholder={lift((range: PriceRange) =>
                    "Max $" + String(range.max)
                  )(priceRange)}
                  style="flex: 1; padding: 8px 12px; border: 2px solid #d1d5db; border-radius: 6px; font-size: 14px;"
                />
                <ct-button
                  onClick={updatePriceInput({
                    input: priceInputCell,
                    price: priceCeiling,
                    range: priceRange,
                  })}
                  style="background: #3b82f6; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; white-space: nowrap;"
                >
                  Apply
                </ct-button>
                <ct-button
                  onClick={clearPriceFilter({
                    price: priceCeiling,
                    input: priceInputCell,
                  })}
                  style="background: #6b7280; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500;"
                >
                  Clear
                </ct-button>
              </div>
            </div>

            <div style="padding: 12px; background: #f3f4f6; border-radius: 6px; font-size: 14px; color: #4b5563; border-left: 4px solid #8b5cf6;">
              {selectionSummary}
            </div>
          </div>
        </ct-card>

        <div>{productCards}</div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      catalog: sanitizedCatalog,
      facets: {
        available: {
          categories: availableCategories,
          brands: availableBrands,
          priceRange,
        },
        selection: {
          categories: selectedCategories,
          brands: selectedBrands,
          priceCeiling,
          summary: selectionSummary,
        },
      },
      results: {
        items: filteredItems,
        count: filteredCount,
        total: totalCount,
        statusLabel,
      },
      controls: {
        toggleCategory: toggleFacet({ target: selectedCategories }),
        toggleBrand: toggleFacet({ target: selectedBrands }),
        setPriceCeiling: setPriceCeiling({
          price: priceCeiling,
          range: priceRange,
        }),
        clearFilters: clearFilters({
          categories: selectedCategories,
          brands: selectedBrands,
          price: priceCeiling,
        }),
      },
    };
  },
);
