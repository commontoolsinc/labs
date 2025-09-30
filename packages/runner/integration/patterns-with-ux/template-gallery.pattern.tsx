/// <cts-enable />
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

interface TemplateSeed {
  id?: string;
  name?: string;
  category?: string;
  summary?: string;
  tags?: unknown;
  popularity?: number;
}

interface TemplateCard {
  id: string;
  name: string;
  categoryKey: string;
  category: string;
  summary: string;
  tags: string[];
  popularity: number;
}

interface CategoryFilter {
  key: string;
  label: string;
  count: number;
}

const defaultTemplateSeeds: TemplateSeed[] = [
  {
    id: "campaign-launch",
    name: "Campaign Launch Plan",
    category: "Marketing",
    summary: "Coordinate channel workstreams for launch readiness.",
    tags: ["campaign", "launch", "checklist"],
    popularity: 92,
  },
  {
    id: "brand-style-guide",
    name: "Brand Style Guide",
    category: "Design",
    summary: "Document voice, typography, and color decisions.",
    tags: ["design", "brand"],
    popularity: 84,
  },
  {
    id: "ops-standup-board",
    name: "Operations Standup Board",
    category: "Operations",
    summary: "Track blockers and owners for daily standups.",
    tags: ["operations", "standup"],
    popularity: 78,
  },
  {
    id: "budget-forecast",
    name: "Budget Forecast Tracker",
    category: "Finance",
    summary: "Model spend scenarios across quarters and teams.",
    tags: ["finance", "forecast"],
    popularity: 73,
  },
  {
    id: "support-playbook",
    name: "Support Response Playbook",
    category: "Support",
    summary: "Outline response templates per severity tier.",
    tags: ["support", "playbook"],
    popularity: 69,
  },
];

interface TemplateGalleryArgs {
  templates: Default<TemplateSeed[], typeof defaultTemplateSeeds>;
  category: Default<string, "all">;
}

interface SelectCategoryEvent {
  category?: string;
}

function sanitizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function slugify(value: string): string {
  const normalized = value.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "general";
}

function formatCategoryLabel(value: string): string {
  const cleaned = value.trim().toLowerCase();
  const parts = cleaned.split(/\s+/);
  const labels = parts
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1));
  return labels.length > 0 ? labels.join(" ") : "General";
}

function sanitizeSummary(value: unknown, fallback: string): string {
  const text = sanitizeText(value);
  return text ?? fallback;
}

function sanitizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const text = sanitizeText(entry);
    if (!text) continue;
    const normalized = text.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(text);
  }
  return tags;
}

function sanitizePopularity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return clamped;
}

function buildTemplateCards(
  seeds: readonly TemplateSeed[],
): TemplateCard[] {
  const cards: TemplateCard[] = [];
  const seen = new Set<string>();
  for (const seed of seeds) {
    const name = sanitizeText(seed?.name);
    const category = sanitizeText(seed?.category);
    if (!name || !category) continue;
    const idSource = sanitizeText(seed?.id) ?? name;
    const id = slugify(idSource);
    if (seen.has(id)) continue;
    const categoryKey = slugify(category);
    const categoryLabel = formatCategoryLabel(category);
    const summary = sanitizeSummary(
      seed?.summary,
      `${categoryLabel} template`,
    );
    const tags = sanitizeTags(seed?.tags);
    const popularity = sanitizePopularity(seed?.popularity);
    cards.push({
      id,
      name,
      categoryKey,
      category: categoryLabel,
      summary,
      tags,
      popularity,
    });
    seen.add(id);
  }
  cards.sort((left, right) => {
    if (right.popularity === left.popularity) {
      return left.name.localeCompare(right.name);
    }
    return right.popularity - left.popularity;
  });
  return cards;
}

const sanitizedDefaultTemplates = buildTemplateCards(defaultTemplateSeeds);

function cloneCards(entries: readonly TemplateCard[]): TemplateCard[] {
  return entries.map((entry) => ({
    ...entry,
    tags: [...entry.tags],
  }));
}

function sanitizeTemplateList(
  value: readonly TemplateSeed[] | undefined,
): TemplateCard[] {
  if (!Array.isArray(value) || value.length === 0) {
    return cloneCards(sanitizedDefaultTemplates);
  }
  const cards = buildTemplateCards(value);
  return cards.length > 0 ? cards : cloneCards(sanitizedDefaultTemplates);
}

function buildCategoryFilters(
  templates: readonly TemplateCard[],
): CategoryFilter[] {
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const entry of templates) {
    const current = counts.get(entry.categoryKey) ?? 0;
    counts.set(entry.categoryKey, current + 1);
    if (!labels.has(entry.categoryKey)) {
      labels.set(entry.categoryKey, entry.category);
    }
  }
  const filters: CategoryFilter[] = [{
    key: "all",
    label: "All",
    count: templates.length,
  }];
  const keys = Array.from(labels.keys());
  keys.sort((left, right) => {
    const leftLabel = labels.get(left) ?? "General";
    const rightLabel = labels.get(right) ?? "General";
    return leftLabel.localeCompare(rightLabel);
  });
  for (const key of keys) {
    filters.push({
      key,
      label: labels.get(key) ?? "General",
      count: counts.get(key) ?? 0,
    });
  }
  return filters;
}

function sanitizeCategoryKey(
  value: unknown,
  valid: readonly string[],
): string {
  const requested = typeof value === "string" ? slugify(value) : "";
  if (requested.length > 0 && valid.includes(requested)) {
    return requested;
  }
  return valid.length > 0 ? valid[0] : "all";
}

function filterTemplates(
  templates: readonly TemplateCard[],
  category: string,
): TemplateCard[] {
  if (category === "all") {
    return cloneCards(templates);
  }
  const matches: TemplateCard[] = [];
  for (const template of templates) {
    if (template.categoryKey === category) {
      matches.push({
        ...template,
        tags: [...template.tags],
      });
    }
  }
  return matches;
}

function resolveCategoryLabel(
  active: string,
  filters: readonly CategoryFilter[],
): string {
  const match = filters.find((filter) => filter.key === active);
  return match ? match.label : "All";
}

const selectCategoryHandler = handler(
  (
    _event: undefined,
    context: {
      input: Cell<string>;
      category: Cell<string>;
      categoryKeys: Cell<string[]>;
      categoryFilters: Cell<CategoryFilter[]>;
      sequence: Cell<number>;
      label: Cell<string>;
      history: Cell<string[]>;
    },
  ) => {
    const requestedCategory = context.input.get() ?? "";
    const keys = context.categoryKeys.get() ?? [];
    const resolved = sanitizeCategoryKey(requestedCategory, keys);
    context.category.set(resolved);

    const filters = context.categoryFilters.get() ?? [];
    const label = resolveCategoryLabel(resolved, filters);
    const next = (context.sequence.get() ?? 0) + 1;
    context.sequence.set(next);
    context.label.set(`Category set to ${label}`);

    const previous = context.history.get() ?? [];
    const updated = [...previous, label];
    const limited = updated.length > 5 ? updated.slice(-5) : updated;
    context.history.set(limited);
    context.input.set("");
  },
);

export const templateGallery = recipe<TemplateGalleryArgs>(
  "Template Gallery",
  ({ templates, category }) => {
    const selectionSequence = cell(0);
    const selectionLabel = cell("initial load");
    const selectionHistory = cell<string[]>([]);
    const selectedCategory = cell<string>("all");
    const categoryInput = cell<string>("");

    const templateList = lift(sanitizeTemplateList)(templates);

    const totalCount = lift((entries: TemplateCard[] | undefined) =>
      Array.isArray(entries) ? entries.length : 0
    )(templateList);

    const categoryFilters = lift(buildCategoryFilters)(templateList);

    const categoryKeys = lift((filters: CategoryFilter[]) =>
      filters.map((filter) => filter.key)
    )(categoryFilters);

    const visibleTemplates = lift((inputs: {
      templates: TemplateCard[];
      category: string;
    }) => filterTemplates(inputs.templates, inputs.category))({
      templates: templateList,
      category: selectedCategory,
    });

    const visibleCount = lift((entries: TemplateCard[] | undefined) =>
      Array.isArray(entries) ? entries.length : 0
    )(visibleTemplates);

    const activeCategoryLabel = lift((inputs: {
      key: string;
      filters: CategoryFilter[];
    }) => resolveCategoryLabel(inputs.key, inputs.filters))({
      key: selectedCategory,
      filters: categoryFilters,
    });

    const summary =
      str`${visibleCount} of ${totalCount} templates in ${activeCategoryLabel}`;

    const featuredTemplate = lift((entries: TemplateCard[]) =>
      entries.length > 0 ? entries[0] : null
    )(visibleTemplates);

    const selectionTrail = lift((entries: string[] | undefined) => {
      if (!Array.isArray(entries) || entries.length === 0) {
        return "No selections yet";
      }
      return entries.join(" → ");
    })(selectionHistory);

    const context = {
      input: categoryInput,
      category: selectedCategory,
      categoryKeys,
      categoryFilters,
      sequence: selectionSequence,
      label: selectionLabel,
      history: selectionHistory,
    } as const;

    const name = str`Template Gallery`;

    const ui = (
      <ct-card style="
          max-width: 1200px;
          margin: 0 auto;
          padding: 1.5rem;
          background: linear-gradient(to bottom, #f8f9fa, #ffffff);
        ">
        <div style="margin-bottom: 2rem;">
          <h1 style="
              margin: 0 0 0.5rem 0;
              font-size: 2rem;
              font-weight: bold;
              color: #1a202c;
            ">
            Template Gallery
          </h1>
          <div style="
              font-size: 1.125rem;
              color: #4a5568;
              margin-bottom: 1rem;
            ">
            {summary}
          </div>
        </div>

        <div style="margin-bottom: 2rem;">
          <div style="
              font-weight: 600;
              margin-bottom: 0.75rem;
              color: #2d3748;
              font-size: 0.875rem;
              text-transform: uppercase;
              letter-spacing: 0.05em;
            ">
            Filter by Category
          </div>
          <div style="display: flex; gap: 0.75rem; align-items: flex-start;">
            <div style="flex: 1; max-width: 400px;">
              <ct-input
                $value={categoryInput}
                placeholder="Enter category (e.g., 'design', 'marketing', 'all')"
                style="
                  width: 100%;
                  padding: 0.625rem;
                  border: 2px solid #cbd5e0;
                  border-radius: 0.5rem;
                  font-size: 0.875rem;
                "
              />
              <ct-button
                onClick={selectCategoryHandler(context as never)}
                style="
                  margin-top: 0.5rem;
                  padding: 0.625rem 1.5rem;
                  background: #3b82f6;
                  color: #ffffff;
                  border: none;
                  border-radius: 0.5rem;
                  font-weight: 600;
                  cursor: pointer;
                  transition: background 0.2s;
                "
              >
                Apply Filter
              </ct-button>
            </div>
            <div style="flex: 1;">
              <div style="
                  font-size: 0.75rem;
                  color: #718096;
                  margin-bottom: 0.5rem;
                  font-weight: 600;
                ">
                Available Categories:
              </div>
              {lift((filters: CategoryFilter[]) => {
                const badges = [];
                for (const filter of filters) {
                  const style =
                    "display: inline-block; padding: 0.25rem 0.75rem; " +
                    "margin-right: 0.375rem; margin-bottom: 0.375rem; " +
                    "background: #edf2f7; border-radius: 1rem; " +
                    "font-size: 0.75rem; color: #4a5568; font-weight: 500;";
                  badges.push(
                    <span style={style}>
                      {filter.key} ({filter.count})
                    </span>,
                  );
                }
                return <div>{badges}</div>;
              })(categoryFilters)}
            </div>
          </div>
        </div>

        <div style="margin-bottom: 2rem;">
          {lift((template: TemplateCard | null) => {
            if (!template) {
              return (
                <div style="
                    padding: 2rem;
                    text-align: center;
                    color: #718096;
                    background: #f7fafc;
                    border-radius: 0.5rem;
                  ">
                  No templates found in this category
                </div>
              );
            }
            const popularityColor = template.popularity >= 80
              ? "#10b981"
              : template.popularity >= 60
              ? "#3b82f6"
              : "#6b7280";
            return (
              <ct-card style="
                  padding: 1.5rem;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  color: #ffffff;
                  border-radius: 0.75rem;
                  box-shadow: 0 10px 25px rgba(102, 126, 234, 0.3);
                ">
                <div style="
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    margin-bottom: 1rem;
                  ">
                  <div style="flex: 1;">
                    <div style="
                        font-size: 0.75rem;
                        font-weight: 600;
                        text-transform: uppercase;
                        letter-spacing: 0.05em;
                        opacity: 0.9;
                        margin-bottom: 0.5rem;
                      ">
                      Featured Template
                    </div>
                    <h2 style="
                        margin: 0 0 0.5rem 0;
                        font-size: 1.75rem;
                        font-weight: bold;
                      ">
                      {template.name}
                    </h2>
                    <div style="
                        font-size: 1rem;
                        opacity: 0.95;
                        line-height: 1.5;
                      ">
                      {template.summary}
                    </div>
                  </div>
                  <div style="
                      display: flex;
                      flex-direction: column;
                      align-items: center;
                      gap: 0.25rem;
                      margin-left: 1rem;
                    ">
                    <div style="
                        font-size: 2rem;
                        font-weight: bold;
                        font-family: monospace;
                      ">
                      {template.popularity}
                    </div>
                    <div style="
                        font-size: 0.75rem;
                        opacity: 0.9;
                        text-transform: uppercase;
                        letter-spacing: 0.05em;
                      ">
                      Score
                    </div>
                  </div>
                </div>
                <div style="
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.5rem;
                    margin-top: 1rem;
                  ">
                  {template.tags.map((tag) => (
                    <span style="
                        display: inline-block;
                        padding: 0.25rem 0.75rem;
                        background: rgba(255, 255, 255, 0.2);
                        border-radius: 1rem;
                        font-size: 0.75rem;
                        font-weight: 500;
                        backdrop-filter: blur(8px);
                      ">
                      #{tag}
                    </span>
                  ))}
                </div>
              </ct-card>
            );
          })(featuredTemplate)}
        </div>

        <div>
          <div style="
              font-weight: 600;
              margin-bottom: 1rem;
              color: #2d3748;
              font-size: 1.125rem;
            ">
            All Templates
          </div>
          {lift((templates: TemplateCard[]) => {
            if (templates.length === 0) {
              return (
                <div style="
                    padding: 3rem;
                    text-align: center;
                    color: #a0aec0;
                    background: #f7fafc;
                    border-radius: 0.5rem;
                    border: 2px dashed #cbd5e0;
                  ">
                  No templates match this filter
                </div>
              );
            }
            const cards = [];
            for (const template of templates) {
              const popularityColor = template.popularity >= 80
                ? "#10b981"
                : template.popularity >= 60
                ? "#3b82f6"
                : "#6b7280";
              const style = "background: #ffffff; padding: 1.25rem; " +
                "border-radius: 0.5rem; border: 1px solid #e2e8f0; " +
                "transition: all 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,0.1);";
              cards.push(
                <ct-card style={style}>
                  <div style="
                      display: flex;
                      justify-content: space-between;
                      align-items: flex-start;
                      margin-bottom: 0.75rem;
                    ">
                    <div style="flex: 1;">
                      <h3 style="
                          margin: 0 0 0.25rem 0;
                          font-size: 1.125rem;
                          font-weight: 600;
                          color: #1a202c;
                        ">
                        {template.name}
                      </h3>
                      <div style="
                          display: inline-block;
                          padding: 0.125rem 0.5rem;
                          background: #edf2f7;
                          border-radius: 0.25rem;
                          font-size: 0.75rem;
                          font-weight: 500;
                          color: #4a5568;
                        ">
                        {template.category}
                      </div>
                    </div>
                    <div
                      style={"display: flex; align-items: center; gap: 0.25rem; " +
                        "padding: 0.25rem 0.75rem; border-radius: 1rem; " +
                        "background: " + popularityColor +
                        "; color: #ffffff; " +
                        "font-weight: 600; font-size: 0.875rem;"}
                    >
                      <span>★</span>
                      <span>{template.popularity}</span>
                    </div>
                  </div>
                  <div style="
                      color: #4a5568;
                      font-size: 0.875rem;
                      line-height: 1.5;
                      margin-bottom: 0.75rem;
                    ">
                    {template.summary}
                  </div>
                  {template.tags.length > 0
                    ? (
                      <div style="display: flex; flex-wrap: wrap; gap: 0.375rem;">
                        {template.tags.map((tag) => (
                          <span style="
                              display: inline-block;
                              padding: 0.125rem 0.5rem;
                              background: #f7fafc;
                              border: 1px solid #e2e8f0;
                              border-radius: 0.25rem;
                              font-size: 0.75rem;
                              color: #718096;
                            ">
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )
                    : null}
                </ct-card>,
              );
            }
            return (
              <div style="
                  display: grid;
                  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
                  gap: 1rem;
                ">
                {cards}
              </div>
            );
          })(visibleTemplates)}
        </div>

        <div style="
            margin-top: 2rem;
            padding: 1rem;
            background: #f7fafc;
            border-radius: 0.5rem;
            border-left: 4px solid #3b82f6;
          ">
          <div style="
              font-size: 0.75rem;
              font-weight: 600;
              text-transform: uppercase;
              letter-spacing: 0.05em;
              color: #4a5568;
              margin-bottom: 0.5rem;
            ">
            Recent Selections
          </div>
          <div style="
              color: #2d3748;
              font-size: 0.875rem;
              font-family: monospace;
            ">
            {selectionTrail}
          </div>
        </div>
      </ct-card>
    );

    return {
      categories: categoryFilters,
      selectedCategory,
      visibleTemplates,
      counts: {
        total: totalCount,
        visible: visibleCount,
      },
      summary,
      featuredTemplate,
      selectionLabel,
      selectionTrail,
      handlers: {
        selectCategory: selectCategoryHandler(context as never),
      },
      [NAME]: name,
      [UI]: ui,
    };
  },
);
