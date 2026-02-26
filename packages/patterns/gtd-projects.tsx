/// <cts-enable />
import {
  action,
  computed,
  type Default,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

// ===== Types =====

interface Project {
  id: string;
  name: string;
  status: string;
  parentId: string;
  childIds: string[];
}

interface Person {
  id: string;
  name: string;
  role: string;
  context: string;
}

interface Directive {
  id: string;
  target: string;
  text: string;
  createdAt: string;
  status: string;
  response: string;
  assignedTo: string;
  noteUrl: string;
}

interface UserAction {
  type: string;
  panel?: string;
  text?: string;
  target?: string;
  ts: string;
}

interface ProjectsInput {
  projects: Writable<Default<Project[], []>>;
  people: Writable<Default<Person[], []>>;
  directives: Writable<Default<Directive[], []>>;
}

interface ProjectsOutput {
  [NAME]: string;
  [UI]: VNode;
  userActions: UserAction[];
}

// ===== Apple-style Design Tokens =====

const font =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif";

const color = {
  label: "#1d1d1f",
  secondaryLabel: "#86868b",
  tertiaryLabel: "#aeaeb2",
  separator: "rgba(60, 60, 67, 0.12)",
  fillPrimary: "rgba(120, 120, 128, 0.08)",
  background: "#ffffff",
  secondaryBg: "#f5f5f7",
  blue: "#007aff",
  green: "#34c759",
  orange: "#ff9500",
  red: "#ff3b30",
  purple: "#af52de",
  indigo: "#5856d6",
};

const panelCardStyle = {
  background: color.background,
  borderRadius: "14px",
  padding: "16px 18px",
  margin: "0 0 10px",
  boxShadow: "0 0.5px 0 rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.04)",
};

const groupHeaderStyle = {
  fontSize: "12px",
  fontWeight: "600",
  textTransform: "uppercase" as const,
  color: color.secondaryLabel,
  letterSpacing: "0.5px",
  padding: "8px 0 4px",
};

const itemRowStyle = {
  fontSize: "14px",
  lineHeight: "1.5",
  padding: "6px 0",
  borderBottom: `0.5px solid ${color.separator}`,
  color: color.label,
};

const directiveInputRowStyle = {
  display: "flex",
  gap: "8px",
  marginTop: "8px",
  alignItems: "center",
};

const directiveSendBtnStyle = {
  padding: "8px 16px",
  borderRadius: "100px",
  fontSize: "13px",
  fontWeight: "600",
  background: color.indigo,
  color: "#fff",
  cursor: "pointer",
  flexShrink: "0",
};

const actionBtnDirective = {
  padding: "5px 14px",
  borderRadius: "100px",
  fontSize: "12px",
  fontWeight: "600",
  background: "rgba(88, 86, 214, 0.12)",
  color: "#5856d6",
  cursor: "pointer",
};

// ===== Pattern =====

const GTDProjects = pattern<ProjectsInput, ProjectsOutput>(
  ({ projects, people, directives }) => {
    // Breadcrumb navigation state — stores "id|name" strings
    const projectBreadcrumbs = Writable.of<string[]>([]);
    const showCompleted = Writable.of<boolean>(false);

    // Per-item selection state
    const selectedItem = Writable.of<string>("");
    const itemDirectiveDraft = Writable.of<string>("");
    const itemDirectiveOpen = Writable.of<boolean>(false);

    // userActions output
    const userActions = Writable.of<UserAction[]>([]);

    // --- Actions ---

    const drillIntoProject = action(
      ({ id, name }: { id: string; name: string }) => {
        const crumbs = [...(projectBreadcrumbs.get() || [])];
        crumbs.push(id + "|" + name);
        projectBreadcrumbs.set(crumbs);
        selectedItem.set("");
        itemDirectiveOpen.set(false);
        itemDirectiveDraft.set("");
      },
    );

    const toggleShowCompleted = action(() => {
      showCompleted.set(!showCompleted.get());
    });

    const navigateBreadcrumb = action(({ depth }: { depth: number }) => {
      if (depth < 0) {
        projectBreadcrumbs.set([]);
      } else {
        const crumbs = [...(projectBreadcrumbs.get() || [])];
        projectBreadcrumbs.set(crumbs.slice(0, depth + 1));
      }
      selectedItem.set("");
      itemDirectiveOpen.set(false);
      itemDirectiveDraft.set("");
    });

    const selectItem = action(({ key }: { key: string }) => {
      const current = selectedItem.get();
      selectedItem.set(current === key ? "" : key);
      itemDirectiveOpen.set(false);
      itemDirectiveDraft.set("");
    });

    const openItemDirective = action(() => {
      itemDirectiveOpen.set(true);
    });

    const sendItemDirective = action(() => {
      const key = selectedItem.get();
      if (!key) return;
      const text = itemDirectiveDraft.get().trim();
      if (!text) return;

      const idx = parseInt(key.split(":")[1]);
      const item = (projects.get() || [])[idx];
      const prefix = item ? "Re: " + item.name + " — " : "";

      const now = new Date().toISOString();
      userActions.set([
        ...userActions.get(),
        {
          type: "directive",
          target: "projects",
          text: prefix + text,
          ts: now,
        },
      ]);

      itemDirectiveDraft.set("");
      itemDirectiveOpen.set(false);
      selectedItem.set("");
    });

    // --- Render ---

    return {
      [NAME]: "GTD Projects",
      userActions,
      [UI]: (
        <div
          style={{
            fontFamily: font,
            maxWidth: "600px",
            margin: "0 auto",
            padding: "20px 16px",
            background: color.background,
            minHeight: "100vh",
          }}
        >
          {/* Header */}
          <div
            style={{
              fontSize: "28px",
              fontWeight: "700",
              color: color.label,
              letterSpacing: "-0.5px",
              marginBottom: "16px",
            }}
          >
            GTD Projects
          </div>

          <div style={panelCardStyle}>
            {/* Breadcrumb bar */}
            {computed(() => {
              const crumbStrs = projectBreadcrumbs.get() || [];
              // Validate breadcrumbs against current data
              const projectItems = [...(projects.get() || [])] as Project[];
              const knownIds = new Set<string>();
              for (const p of projectItems) {
                knownIds.add(p.id);
                if (p.parentId) knownIds.add(p.parentId);
              }
              let crumbs = crumbStrs.map((s: string) => {
                const bar = s.indexOf("|");
                return {
                  id: bar >= 0 ? s.substring(0, bar) : s,
                  name: bar >= 0 ? s.substring(bar + 1) : s,
                };
              });
              // If any crumb references an ID not in current data, treat as root
              if (crumbs.length > 0 && crumbs.some(
                (c: { id: string; name: string }) => !knownIds.has(c.id),
              )) {
                crumbs = [];
              }
              if (crumbs.length === 0) {
                return (
                  <div
                    style={{
                      ...groupHeaderStyle,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <span>Projects</span>
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: "500",
                        color: showCompleted.get()
                          ? color.blue
                          : color.tertiaryLabel,
                        cursor: "pointer",
                      }}
                      onClick={toggleShowCompleted}
                    >
                      {showCompleted.get() ? "Hide Done" : "Show Done"}
                    </span>
                  </div>
                );
              }
              return (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0",
                    flexWrap: "wrap" as const,
                    padding: "4px 0 8px",
                  }}
                >
                  <span
                    style={{
                      fontSize: "13px",
                      fontWeight: "500",
                      color: color.blue,
                      cursor: "pointer",
                    }}
                    onClick={() =>
                      navigateBreadcrumb.send({ depth: -1 })
                    }
                  >
                    Projects
                  </span>
                  {crumbs.map(
                    (
                      c: { id: string; name: string },
                      i: number,
                    ) => (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                        }}
                      >
                        <span
                          style={{
                            fontSize: "12px",
                            color: color.tertiaryLabel,
                            margin: "0 6px",
                          }}
                        >
                          /
                        </span>
                        {i < crumbs.length - 1 ? (
                          <span
                            style={{
                              fontSize: "13px",
                              fontWeight: "500",
                              color: color.blue,
                              cursor: "pointer",
                            }}
                            onClick={() =>
                              navigateBreadcrumb.send({
                                depth: i,
                              })
                            }
                          >
                            {c.name}
                          </span>
                        ) : (
                          <span
                            style={{
                              fontSize: "13px",
                              fontWeight: "600",
                              color: color.label,
                            }}
                          >
                            {c.name}
                          </span>
                        )}
                      </span>
                    ),
                  )}
                </div>
              );
            })}
            {computed(() => {
              const projectItems = [...(projects.get() || [])] as Project[];
              const peopleItems = [...(people.get() || [])] as Person[];
              const crumbStrs2 = projectBreadcrumbs.get() || [];
              let crumbs = crumbStrs2.map((s: string) => {
                const bar = s.indexOf("|");
                return {
                  id: bar >= 0 ? s.substring(0, bar) : s,
                  name: bar >= 0 ? s.substring(bar + 1) : s,
                };
              });

              // Build project name -> noteUrl lookup from directives
              const projectNotes: Record<string, string> = {};
              const allDirs: Directive[] = [
                ...(directives.get() || []),
              ].filter(
                (d: Directive) => d && d.id && d.noteUrl,
              );
              for (const d of allDirs) {
                const m = d.text.match(/^Re:\s*(.+?)\s*—/);
                if (m) projectNotes[m[1]] = d.noteUrl;
              }

              if (projectItems.length === 0) {
                return (
                  <div
                    style={{
                      fontSize: "13px",
                      color: color.tertiaryLabel,
                      padding: "12px 0",
                    }}
                  >
                    No projects
                  </div>
                );
              }

              const hideCompleted = !showCompleted.get();
              const isCompleted = (s: string) =>
                s === "Done" || s === "Archived";

              // Build children-of map
              const childrenOf: Record<string, Project[]> = {};
              const visibleChildrenOf: Record<string, Project[]> =
                {};
              // Also collect all known IDs (projects + person parents)
              const knownIds = new Set<string>();
              for (const p of projectItems) {
                knownIds.add(p.id);
                if (p.parentId) {
                  knownIds.add(p.parentId);
                  if (!childrenOf[p.parentId])
                    childrenOf[p.parentId] = [];
                  childrenOf[p.parentId].push(p);
                  if (
                    !hideCompleted ||
                    !isCompleted(p.status)
                  ) {
                    if (!visibleChildrenOf[p.parentId])
                      visibleChildrenOf[p.parentId] = [];
                    visibleChildrenOf[p.parentId].push(p);
                  }
                }
              }

              // Validate breadcrumbs: if any crumb ID doesn't
              // exist in the current data, treat as root level
              if (crumbs.length > 0) {
                const invalid = crumbs.some(
                  (c: { id: string; name: string }) => !knownIds.has(c.id),
                );
                if (invalid) {
                  crumbs = [];
                }
              }

              // Determine visible items at current breadcrumb depth
              let visibleItems: {
                type: string;
                id: string;
                name: string;
                project: Project | null;
                idx: number;
                hasChildren: boolean;
              }[] = [];

              if (crumbs.length === 0) {
                // Root level: person groups + top-level projects
                for (const parentId of Object.keys(
                  visibleChildrenOf,
                )) {
                  if (parentId.startsWith("PPL:")) {
                    const person = peopleItems.find(
                      (pp: Person) => pp.id === parentId,
                    );
                    const name = person
                      ? person.name
                      : parentId.split(":")[1];
                    visibleItems.push({
                      type: "person",
                      id: parentId,
                      name,
                      project: null,
                      idx: -1,
                      hasChildren: true,
                    });
                  }
                }
                for (const p of projectItems) {
                  if (!p.parentId) {
                    if (hideCompleted && isCompleted(p.status))
                      continue;
                    const idx = projectItems.indexOf(p);
                    const hasKids =
                      (visibleChildrenOf[p.id] || []).length >
                      0;
                    visibleItems.push({
                      type: "project",
                      id: p.id,
                      name: p.name,
                      project: p,
                      idx,
                      hasChildren: hasKids,
                    });
                  }
                }
              } else {
                // Drilled into a node — show its children
                const currentId =
                  crumbs[crumbs.length - 1].id;
                const children =
                  childrenOf[currentId] || [];
                for (const child of children) {
                  if (
                    hideCompleted &&
                    isCompleted(child.status)
                  )
                    continue;
                  const idx = projectItems.indexOf(child);
                  const hasKids =
                    (visibleChildrenOf[child.id] || [])
                      .length > 0;
                  visibleItems.push({
                    type: "project",
                    id: child.id,
                    name: child.name,
                    project: child,
                    idx,
                    hasChildren: hasKids,
                  });
                }
              }

              if (visibleItems.length === 0) {
                return (
                  <div
                    style={{
                      fontSize: "13px",
                      color: color.tertiaryLabel,
                      padding: "12px 0",
                    }}
                  >
                    {crumbs.length > 0 ? "No child items" : "No projects"}
                  </div>
                );
              }

              return visibleItems.map(
                (item: {
                  type: string;
                  id: string;
                  name: string;
                  project: Project | null;
                  idx: number;
                  hasChildren: boolean;
                }) => {
                  if (item.type === "person") {
                    return (
                      <div
                        style={{
                          ...itemRowStyle,
                          display: "flex",
                          alignItems: "center",
                          gap: "10px",
                          cursor: "pointer",
                        }}
                        onClick={() =>
                          drillIntoProject.send({
                            id: item.id,
                            name: item.name,
                          })
                        }
                      >
                        <span
                          style={{
                            fontSize: "13px",
                            fontWeight: "600",
                            color: color.purple,
                            flex: "1",
                          }}
                        >
                          {item.name}
                        </span>
                        <span
                          style={{
                            fontSize: "11px",
                            color: color.tertiaryLabel,
                          }}
                        >
                          {(
                            visibleChildrenOf[item.id] || []
                          ).length + " items"}
                        </span>
                        <span
                          style={{
                            fontSize: "14px",
                            color: color.tertiaryLabel,
                            flexShrink: "0",
                          }}
                        >
                          {">"}
                        </span>
                      </div>
                    );
                  }

                  // Project row
                  const p = item.project!;
                  const idx = item.idx;
                  return (
                    <div>
                      <div
                        style={computed(() =>
                          selectedItem.get() ===
                          "projects:" + idx
                            ? {
                                ...itemRowStyle,
                                display: "flex",
                                alignItems: "center",
                                gap: "0px",
                                cursor: "pointer",
                                background:
                                  "rgba(0, 122, 255, 0.06)",
                                borderRadius: "8px",
                                padding: "8px",
                              }
                            : {
                                ...itemRowStyle,
                                display: "flex",
                                alignItems: "center",
                                gap: "0px",
                                cursor: "pointer",
                              },
                        )}
                      >
                        {/* Item content — click to select */}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "10px",
                            flex: "1",
                            cursor: "pointer",
                          }}
                          onClick={() =>
                            selectItem.send({
                              key: "projects:" + idx,
                            })
                          }
                        >
                          <span
                            style={{
                              fontSize: "12px",
                              color: color.tertiaryLabel,
                              fontWeight: "500",
                              minWidth: "32px",
                              flexShrink: "0",
                            }}
                          >
                            {p.id}
                          </span>
                          <span style={{ flex: "1" }}>
                            {p.name}
                          </span>
                          <span
                            style={{
                              padding: "2px 10px",
                              borderRadius: "100px",
                              fontSize: "11px",
                              fontWeight: "500",
                              background:
                                p.status === "Active"
                                  ? "rgba(52, 199, 89, 0.12)"
                                  : p.status === "Done"
                                    ? "rgba(142, 142, 147, 0.12)"
                                    : "rgba(255, 149, 0, 0.12)",
                              color:
                                p.status === "Active"
                                  ? "#34c759"
                                  : p.status === "Done"
                                    ? "#8e8e93"
                                    : "#ff9500",
                              flexShrink: "0",
                            }}
                          >
                            {p.status}
                          </span>
                        </div>
                        {projectNotes[p.name] ? (
                          <a
                            href={projectNotes[p.name]}
                            target="_blank"
                            style={{
                              textDecoration: "none",
                              fontSize: "16px",
                              flexShrink: "0",
                              cursor: "pointer",
                              marginLeft: "4px",
                            }}
                          >
                            {"📎"}
                          </a>
                        ) : null}
                        {/* Drill-in chevron */}
                        {item.hasChildren ? (
                          <div
                            style={{
                              padding: "4px 0 4px 8px",
                              cursor: "pointer",
                              flexShrink: "0",
                            }}
                            onClick={() =>
                              drillIntoProject.send({
                                id: item.id,
                                name: p.name,
                              })
                            }
                          >
                            <span
                              style={{
                                fontSize: "14px",
                                color: color.tertiaryLabel,
                              }}
                            >
                              {">"}
                            </span>
                          </div>
                        ) : null}
                      </div>
                      {ifElse(
                        computed(
                          () =>
                            selectedItem.get() ===
                            "projects:" + idx,
                        ),
                        <div>
                          <div
                            style={{
                              display: "flex",
                              gap: "8px",
                              padding: "6px 0 8px",
                            }}
                          >
                            <div
                              style={actionBtnDirective}
                              onClick={openItemDirective}
                            >
                              → Directive
                            </div>
                          </div>
                          {ifElse(
                            computed(() =>
                              itemDirectiveOpen.get(),
                            ),
                            <div
                              style={directiveInputRowStyle}
                            >
                              <ct-textarea
                                $value={itemDirectiveDraft}
                                placeholder="Directive about this project..."
                                rows={1}
                                style={{
                                  flex: "1",
                                  borderRadius: "10px",
                                  fontSize: "14px",
                                }}
                              />
                              <div
                                style={directiveSendBtnStyle}
                                onClick={sendItemDirective}
                              >
                                Send
                              </div>
                            </div>,
                            null,
                          )}
                        </div>,
                        null,
                      )}
                    </div>
                  );
                },
              );
            })}
          </div>
        </div>
      ),
    };
  },
);

export default GTDProjects;
