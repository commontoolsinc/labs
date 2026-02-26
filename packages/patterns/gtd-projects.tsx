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

// ===== Helpers =====

// Find completed directives targeting a project by name
const directivesForProject = (
  projectName: string,
  allDirectives: Directive[],
): Directive[] => {
  return allDirectives.filter((d: Directive) => {
    if (!d || d.status !== "done" || !d.response) return false;
    const m = d.text.match(/^Re:\s*(.+?)\s*—/);
    return m && m[1] === projectName;
  });
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

    // Action: drill into a directive response
    const drillIntoDirective = action(
      ({ directiveId }: { directiveId: string }) => {
        const crumbs = [...(projectBreadcrumbs.get() || [])];
        crumbs.push("DIR:" + directiveId + "|" + directiveId);
        projectBreadcrumbs.set(crumbs);
        selectedItem.set("");
        itemDirectiveOpen.set(false);
        itemDirectiveDraft.set("");
      },
    );

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
              // Also add directive IDs as known
              const allDirs: Directive[] = [...(directives.get() || [])];
              for (const d of allDirs) {
                if (d && d.id) knownIds.add("DIR:" + d.id);
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
                            {c.id.startsWith("DIR:") ? c.id.replace("DIR:", "") : c.name}
                          </span>
                        ) : (
                          <span
                            style={{
                              fontSize: "13px",
                              fontWeight: "600",
                              color: c.id.startsWith("DIR:") ? color.indigo : color.label,
                            }}
                          >
                            {c.id.startsWith("DIR:") ? c.id.replace("DIR:", "") : c.name}
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
              const allDirectives: Directive[] = [...(directives.get() || [])];
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
              for (const d of allDirectives) {
                if (d && d.id && d.noteUrl) {
                  const m = d.text.match(/^Re:\s*(.+?)\s*—/);
                  if (m) projectNotes[m[1]] = d.noteUrl;
                }
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
              // Also add directive IDs as known
              for (const d of allDirectives) {
                if (d && d.id) knownIds.add("DIR:" + d.id);
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

              // Check if last breadcrumb is a directive detail view
              if (crumbs.length > 0 && crumbs[crumbs.length - 1].id.startsWith("DIR:")) {
                const dirId = crumbs[crumbs.length - 1].id.replace("DIR:", "");
                const dir = allDirectives.find((d: Directive) => d.id === dirId);
                if (!dir) {
                  return (
                    <div style={{ fontSize: "13px", color: color.tertiaryLabel, padding: "12px 0" }}>
                      Directive not found
                    </div>
                  );
                }
                // Extract the question part (after "Re: ProjectName — ")
                const questionMatch = dir.text.match(/^Re:\s*.+?\s*—\s*(.+)$/);
                const question = questionMatch ? questionMatch[1] : dir.text;
                const dateStr = dir.createdAt
                  ? new Date(dir.createdAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })
                  : "";
                return (
                  <div style={{ padding: "4px 0" }}>
                    {/* Directive header */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        marginBottom: "12px",
                      }}
                    >
                      <span
                        style={{
                          padding: "2px 8px",
                          borderRadius: "6px",
                          fontSize: "11px",
                          fontWeight: "600",
                          background: "rgba(88, 86, 214, 0.12)",
                          color: color.indigo,
                        }}
                      >
                        {dir.id}
                      </span>
                      <span style={{ fontSize: "12px", color: color.secondaryLabel }}>
                        {dateStr}
                      </span>
                    </div>
                    {/* Question */}
                    <div style={{ marginBottom: "16px" }}>
                      <div
                        style={{
                          fontSize: "11px",
                          fontWeight: "600",
                          textTransform: "uppercase" as const,
                          color: color.secondaryLabel,
                          letterSpacing: "0.5px",
                          marginBottom: "6px",
                        }}
                      >
                        Asked
                      </div>
                      <div
                        style={{
                          fontSize: "14px",
                          lineHeight: "1.5",
                          color: color.label,
                          background: color.fillPrimary,
                          borderRadius: "8px",
                          padding: "10px 12px",
                        }}
                      >
                        {question}
                      </div>
                    </div>
                    {/* Response */}
                    <div style={{ marginBottom: "12px" }}>
                      <div
                        style={{
                          fontSize: "11px",
                          fontWeight: "600",
                          textTransform: "uppercase" as const,
                          color: color.secondaryLabel,
                          letterSpacing: "0.5px",
                          marginBottom: "6px",
                        }}
                      >
                        Response
                      </div>
                      <div
                        style={{
                          fontSize: "14px",
                          lineHeight: "1.6",
                          color: color.label,
                          whiteSpace: "pre-wrap" as const,
                        }}
                      >
                        {dir.response}
                      </div>
                    </div>
                    {/* Note link */}
                    {dir.noteUrl ? (
                      <a
                        href={dir.noteUrl}
                        target="_blank"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          fontSize: "13px",
                          color: color.blue,
                          textDecoration: "none",
                          padding: "6px 12px",
                          borderRadius: "8px",
                          background: "rgba(0, 122, 255, 0.08)",
                          cursor: "pointer",
                        }}
                      >
                        {"📎 View attached note"}
                      </a>
                    ) : null}
                  </div>
                );
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

              // Find the current project name for directive matching
              let currentProjectName = "";

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
                    // Check if this project has directives
                    const projDirs = directivesForProject(p.name, allDirectives);
                    visibleItems.push({
                      type: "project",
                      id: p.id,
                      name: p.name,
                      project: p,
                      idx,
                      hasChildren: hasKids || projDirs.length > 0,
                    });
                  }
                }
              } else {
                // Drilled into a node — show its children
                const currentId =
                  crumbs[crumbs.length - 1].id;
                // Look up the project name for directive matching
                const currentProject = projectItems.find(
                  (p: Project) => p.id === currentId,
                );
                currentProjectName = currentProject ? currentProject.name : "";

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
                  const childDirs = directivesForProject(child.name, allDirectives);
                  visibleItems.push({
                    type: "project",
                    id: child.id,
                    name: child.name,
                    project: child,
                    idx,
                    hasChildren: hasKids || childDirs.length > 0,
                  });
                }
              }

              // Get directives for the current drilled-in project
              const currentDirs = currentProjectName
                ? directivesForProject(currentProjectName, allDirectives)
                : [];

              const hasContent = visibleItems.length > 0 || currentDirs.length > 0;

              if (!hasContent) {
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

              return (
                <div>
                  {visibleItems.map(
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
                  )}
                  {/* Directive responses section — only when drilled into a project */}
                  {currentDirs.length > 0 ? (
                    <div style={{ marginTop: "4px" }}>
                      <div style={{ ...groupHeaderStyle, padding: "10px 0 6px" }}>
                        Responses ({currentDirs.length})
                      </div>
                      {currentDirs.map((d: Directive) => {
                        const questionMatch = d.text.match(/^Re:\s*.+?\s*—\s*(.+)$/);
                        const question = questionMatch ? questionMatch[1] : d.text;
                        const truncatedResponse =
                          d.response.length > 120
                            ? d.response.substring(0, 120) + "..."
                            : d.response;
                        const dateStr = d.createdAt
                          ? new Date(d.createdAt).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                            })
                          : "";
                        return (
                          <div
                            style={{
                              ...itemRowStyle,
                              display: "flex",
                              alignItems: "flex-start",
                              gap: "10px",
                              cursor: "pointer",
                            }}
                            onClick={() =>
                              drillIntoDirective.send({
                                directiveId: d.id,
                              })
                            }
                          >
                            <span
                              style={{
                                padding: "2px 6px",
                                borderRadius: "4px",
                                fontSize: "10px",
                                fontWeight: "600",
                                background: "rgba(88, 86, 214, 0.12)",
                                color: color.indigo,
                                flexShrink: "0",
                                marginTop: "2px",
                              }}
                            >
                              {d.id}
                            </span>
                            <div style={{ flex: "1", minWidth: "0" }}>
                              <div
                                style={{
                                  fontSize: "13px",
                                  fontWeight: "500",
                                  color: color.label,
                                  marginBottom: "2px",
                                }}
                              >
                                {question}
                              </div>
                              <div
                                style={{
                                  fontSize: "12px",
                                  color: color.secondaryLabel,
                                  lineHeight: "1.4",
                                }}
                              >
                                {truncatedResponse}
                              </div>
                            </div>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                flexShrink: "0",
                                marginTop: "2px",
                              }}
                            >
                              {d.noteUrl ? (
                                <span style={{ fontSize: "14px" }}>{"📎"}</span>
                              ) : null}
                              <span
                                style={{
                                  fontSize: "11px",
                                  color: color.tertiaryLabel,
                                }}
                              >
                                {dateStr}
                              </span>
                              <span
                                style={{
                                  fontSize: "14px",
                                  color: color.tertiaryLabel,
                                }}
                              >
                                {">"}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ),
    };
  },
);

export default GTDProjects;
