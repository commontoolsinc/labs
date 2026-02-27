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

interface NextAction {
  context: string;
  section: string;
  text: string;
  projectId: string;
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
  actions: Writable<Default<NextAction[], []>>;
  directives: Writable<Default<Directive[], []>>;
  spaceName: Writable<Default<string, "">>;
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

const actionBtnDone = {
  padding: "5px 14px",
  borderRadius: "100px",
  fontSize: "12px",
  fontWeight: "600",
  background: "rgba(52, 199, 89, 0.12)",
  color: "#34c759",
  cursor: "pointer",
};

const actionBtnDelete = {
  padding: "5px 14px",
  borderRadius: "100px",
  fontSize: "12px",
  fontWeight: "600",
  background: "rgba(255, 59, 48, 0.12)",
  color: "#ff3b30",
  cursor: "pointer",
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

const actionBtnAdd = {
  padding: "5px 14px",
  borderRadius: "100px",
  fontSize: "12px",
  fontWeight: "600",
  background: "rgba(52, 199, 89, 0.12)",
  color: "#34c759",
  cursor: "pointer",
};

// ===== Pattern =====

const GTDProjects = pattern<ProjectsInput, ProjectsOutput>(
  ({ projects, people, actions, directives, spaceName }) => {
    // Breadcrumb navigation state — stores "id|name" strings
    const projectBreadcrumbs = Writable.of<string[]>([]);
    const showCompleted = Writable.of<boolean>(false);

    // Per-item selection state
    const selectedItem = Writable.of<string>("");
    const itemDirectiveDraft = Writable.of<string>("");
    const itemDirectiveOpen = Writable.of<boolean>(false);

    // Breadcrumb-level directive state
    const breadcrumbDirectiveOpen = Writable.of<boolean>(false);
    const breadcrumbDirectiveDraft = Writable.of<string>("");
    const breadcrumbDirectivePrefix = Writable.of<string>("");

    // Add project/subproject state
    const addItemOpen = Writable.of<boolean>(false);
    const addItemDraft = Writable.of<string>("");

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
        breadcrumbDirectiveOpen.set(false);
        addItemOpen.set(false);
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
      breadcrumbDirectiveOpen.set(false);
      addItemOpen.set(false);
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

    const markItemDone = action(({ key }: { key: string }) => {
      const [panel, idxStr] = [key.split(":")[0], key.split(":")[1]];
      const idx = parseInt(idxStr);
      const now = new Date().toISOString();
      let text = "";
      if (panel === "projects") {
        const item = (projects.get() || [])[idx];
        if (item) text = item.name;
      } else if (panel === "actions") {
        const item = (actions.get() || [])[idx];
        if (item) text = item.text;
      }
      if (text) {
        userActions.set([...userActions.get(), { type: "done", panel, text, ts: now }]);
      }
      selectedItem.set("");
    });

    const deleteItem = action(({ key }: { key: string }) => {
      const [panel, idxStr] = [key.split(":")[0], key.split(":")[1]];
      const idx = parseInt(idxStr);
      const now = new Date().toISOString();
      let text = "";
      if (panel === "projects") {
        const item = (projects.get() || [])[idx];
        if (item) text = item.name;
      }
      if (text) {
        userActions.set([...userActions.get(), { type: "delete", panel, text, ts: now }]);
      }
      selectedItem.set("");
    });

    const openBreadcrumbDirective = action(({ prefix }: { prefix: string }) => {
      breadcrumbDirectiveOpen.set(true);
      breadcrumbDirectivePrefix.set(prefix);
      breadcrumbDirectiveDraft.set("");
      selectedItem.set("");
      itemDirectiveOpen.set(false);
    });

    const sendBreadcrumbDirective = action(() => {
      const text = breadcrumbDirectiveDraft.get().trim();
      if (!text) return;
      const prefix = breadcrumbDirectivePrefix.get();
      const now = new Date().toISOString();
      userActions.set([
        ...userActions.get(),
        { type: "directive", target: "projects", text: prefix + text, ts: now },
      ]);
      breadcrumbDirectiveDraft.set("");
      breadcrumbDirectiveOpen.set(false);
    });

    const openAddItem = action(() => {
      addItemOpen.set(true);
      addItemDraft.set("");
      selectedItem.set("");
      itemDirectiveOpen.set(false);
    });

    const drillAndAddSubproject = action(
      ({ id, name }: { id: string; name: string }) => {
        const crumbs = [...(projectBreadcrumbs.get() || [])];
        crumbs.push(id + "|" + name);
        projectBreadcrumbs.set(crumbs);
        selectedItem.set("");
        itemDirectiveOpen.set(false);
        itemDirectiveDraft.set("");
        breadcrumbDirectiveOpen.set(false);
        addItemOpen.set(true);
        addItemDraft.set("");
      },
    );

    const sendAddItem = action(() => {
      const text = addItemDraft.get().trim();
      if (!text) return;
      const now = new Date().toISOString();
      const crumbs = projectBreadcrumbs.get() || [];
      if (crumbs.length > 0) {
        const last = crumbs[crumbs.length - 1];
        const bar = last.indexOf("|");
        const parentName = bar >= 0 ? last.substring(bar + 1) : last;
        userActions.set([...userActions.get(), { type: "directive", target: "projects", text: "Add subproject to " + parentName + ": " + text, ts: now }]);
      } else {
        userActions.set([...userActions.get(), { type: "add", panel: "projects", text, ts: now }]);
      }
      addItemDraft.set("");
      addItemOpen.set(false);
    });

    // --- Data-only computed cells (no VNodes, no onClick) ---

    // Validated breadcrumb array
    const breadcrumbCrumbs = computed(() => {
      const crumbStrs = projectBreadcrumbs.get() || [];
      const projectItems = [...(projects.get() || [])] as Project[];
      const knownIds = new Set<string>();
      for (const p of projectItems) {
        knownIds.add(p.id);
        if (p.parentId) knownIds.add(p.parentId);
      }
      const crumbs = crumbStrs.map((s: string) => {
        const bar = s.indexOf("|");
        return {
          id: bar >= 0 ? s.substring(0, bar) : s,
          name: bar >= 0 ? s.substring(bar + 1) : s,
        };
      });
      if (crumbs.length > 0 && crumbs.some((c: { id: string; name: string }) => !knownIds.has(c.id))) {
        return [];
      }
      return crumbs;
    });

    // Project name → noteUrl lookup
    const projectNotesMap = computed(() => {
      const currentSpace = spaceName.get() || "GTDfeb27";
      const notes: Record<string, string> = {};
      const allDirs = [...(directives.get() || [])].filter(
        (d: Directive) => d && d.id && d.noteUrl,
      );
      for (const d of allDirs) {
        const m = d.text.match(/^Re:\s*(.+?)\s*\u2014/);
        if (m && d.noteUrl) {
          let url = d.noteUrl;
          if (url.match(/^\/[^\/]+\/baedrei/)) url = "/" + currentSpace + url.substring(url.indexOf("/", 1));
          notes[m[1]] = url;
        }
      }
      return notes;
    });

    // Visible items at current breadcrumb depth
    const visibleItemsData = computed(() => {
      const projectItems = [...(projects.get() || [])] as Project[];
      const peopleItems = [...(people.get() || [])] as Person[];
      const actionItems = [...(actions.get() || [])] as NextAction[];
      const crumbs = breadcrumbCrumbs;

      if (projectItems.length === 0) return [];

      const hideCompleted = !showCompleted.get();
      const isCompleted = (s: string) => s === "Done" || s === "Archived";

      // Build children-of maps
      const childrenOf: Record<string, Project[]> = {};
      const visibleChildrenOf: Record<string, Project[]> = {};
      for (const p of projectItems) {
        if (p.parentId) {
          if (!childrenOf[p.parentId]) childrenOf[p.parentId] = [];
          childrenOf[p.parentId].push(p);
          if (!hideCompleted || !isCompleted(p.status)) {
            if (!visibleChildrenOf[p.parentId]) visibleChildrenOf[p.parentId] = [];
            visibleChildrenOf[p.parentId].push(p);
          }
        }
      }

      // Project IDs with linked actions
      const projectsWithActions = new Set<string>();
      for (const a of actionItems) {
        if (a.projectId) projectsWithActions.add(a.projectId);
      }

      // Project names with directive responses
      const allDirectives = [...(directives.get() || [])] as Directive[];
      const projectsWithResponses = new Set<string>();
      for (const d of allDirectives) {
        if (!d || d.status !== "done" || !d.response) continue;
        const dm = d.text.match(/^Re:\s*(.+?)\s*\u2014/);
        if (dm) projectsWithResponses.add(dm[1]);
      }

      // Build visible items
      const items: {
        type: string; id: string; name: string;
        project: Project | null; action: NextAction | null;
        directive: Directive | null;
        idx: number; hasChildren: boolean; childCount: number;
      }[] = [];

      if (crumbs.length === 0) {
        // Root level: person groups + top-level projects
        for (const parentId of Object.keys(visibleChildrenOf)) {
          if (parentId.startsWith("PPL:")) {
            const person = peopleItems.find((pp: Person) => pp.id === parentId);
            const name = person ? person.name : parentId.split(":")[1];
            items.push({
              type: "person", id: parentId, name,
              project: null, action: null, directive: null,
              idx: -1, hasChildren: true,
              childCount: (visibleChildrenOf[parentId] || []).length,
            });
          }
        }
        for (const p of projectItems) {
          if (!p.parentId) {
            if (hideCompleted && isCompleted(p.status)) continue;
            const idx = projectItems.indexOf(p);
            const hasKids =
              (visibleChildrenOf[p.id] || []).length > 0
              || projectsWithActions.has(p.id)
              || projectsWithResponses.has(p.name);
            items.push({
              type: "project", id: p.id, name: p.name,
              project: p, action: null, directive: null,
              idx, hasChildren: hasKids, childCount: 0,
            });
          }
        }
      } else {
        // Drilled into a node
        const currentId = crumbs[crumbs.length - 1].id;
        const currentProject = projectItems.find((p: Project) => p.id === currentId);
        const children = childrenOf[currentId] || [];
        for (const child of children) {
          if (hideCompleted && isCompleted(child.status)) continue;
          const idx = projectItems.indexOf(child);
          const hasKids =
            (visibleChildrenOf[child.id] || []).length > 0
            || projectsWithActions.has(child.id)
            || projectsWithResponses.has(child.name);
          items.push({
            type: "project", id: child.id, name: child.name,
            project: child, action: null, directive: null,
            idx, hasChildren: hasKids, childCount: 0,
          });
        }
        // Related next actions
        const projectActions = actionItems.filter((a: NextAction) => a.projectId === currentId);
        for (let ai = 0; ai < projectActions.length; ai++) {
          const pa = projectActions[ai];
          const origIdx = actionItems.indexOf(pa);
          items.push({
            type: "action", id: "action-" + origIdx, name: pa.text,
            project: null, action: pa, directive: null,
            idx: origIdx, hasChildren: false, childCount: 0,
          });
        }
        // Completed directive responses
        const currentSpace = spaceName.get() || "GTDfeb27";
        if (currentProject) {
          for (const d of allDirectives) {
            if (!d || d.status !== "done" || !d.response) continue;
            const dm = d.text.match(/^Re:\s*(.+?)\s*\u2014/);
            if (dm && dm[1] === currentProject.name) {
              let noteLink = d.noteUrl || "";
              if (noteLink && noteLink.match(/^\/[^\/]+\/baedrei/)) {
                noteLink = "/" + currentSpace + noteLink.substring(noteLink.indexOf("/", 1));
              }
              items.push({
                type: "response", id: d.id, name: d.text,
                project: null, action: null,
                directive: { ...d, noteUrl: noteLink },
                idx: -1, hasChildren: false, childCount: 0,
              });
            }
          }
        }
      }

      return items;
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
            {/* Breadcrumb bar — ifElse for onClick safety */}
            {ifElse(
              computed(() => (breadcrumbCrumbs).length === 0),
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
                  style={computed(() => ({
                    fontSize: "11px",
                    fontWeight: "500",
                    color: showCompleted.get() ? color.blue : color.tertiaryLabel,
                    cursor: "pointer",
                  }))}
                  onClick={toggleShowCompleted}
                >
                  {computed(() => showCompleted.get() ? "Hide Done" : "Show Done")}
                </span>
              </div>,
              <div>
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
                    onClick={() => navigateBreadcrumb.send({ depth: -1 })}
                  >
                    Projects
                  </span>
                  {breadcrumbCrumbs.map(
                    (c: { id: string; name: string }, i: number) => (
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
                        {/* Ternary auto-converts to ifElse — onClick safe */}
                        {i < (breadcrumbCrumbs).length - 1 ? (
                          <span
                            style={{
                              fontSize: "13px",
                              fontWeight: "500",
                              color: color.blue,
                              cursor: "pointer",
                            }}
                            onClick={() => navigateBreadcrumb.send({ depth: i })}
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
                  <div
                    style={{ marginLeft: "auto", ...actionBtnDirective, fontSize: "11px", padding: "3px 10px" }}
                    onClick={() => {
                      const crumbs = breadcrumbCrumbs;
                      const current = crumbs[crumbs.length - 1];
                      if (current) openBreadcrumbDirective.send({ prefix: "Re: " + current.name + " \u2014 " });
                    }}
                  >
                    → Directive
                  </div>
                </div>
                {ifElse(
                  breadcrumbDirectiveOpen,
                  <div style={{ ...directiveInputRowStyle, marginBottom: "8px" }}>
                    <ct-textarea
                      $value={breadcrumbDirectiveDraft}
                      placeholder={computed(() => {
                        const crumbs = breadcrumbCrumbs;
                        const current = crumbs[crumbs.length - 1];
                        return current ? "Directive about " + current.name + "..." : "Directive...";
                      })}
                      rows={1}
                      style="flex: 1; border-radius: 10px; font-size: 14px;"
                    />
                    <div style={directiveSendBtnStyle} onClick={sendBreadcrumbDirective}>
                      Send
                    </div>
                  </div>,
                  null,
                )}
              </div>,
            )}
            {/* Empty state — read-only computed, no onClick */}
            {computed(() => {
              const items = visibleItemsData;
              const crumbs = breadcrumbCrumbs;
              if (items.length === 0 && crumbs.length > 0) {
                return (
                  <div style={{ fontSize: "13px", color: color.tertiaryLabel, padding: "12px 0" }}>
                    No child items
                  </div>
                );
              }
              if (items.length === 0) {
                return (
                  <div style={{ fontSize: "13px", color: color.tertiaryLabel, padding: "12px 0" }}>
                    No projects
                  </div>
                );
              }
              return null;
            })}
            {/* Item rows — .map() on computed array, ternaries auto-convert to ifElse */}
            {visibleItemsData.map(
              (item: {
                type: string; id: string; name: string;
                project: Project | null; action: NextAction | null;
                directive: Directive | null;
                idx: number; hasChildren: boolean; childCount: number;
              }) =>
                /* Action row */
                ifElse(computed(() => item.type === "action"),
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      padding: "5px 0 5px 12px",
                      borderBottom: `0.5px solid ${color.separator}`,
                    }}
                  >
                    <ct-checkbox
                      checked={false}
                      style="width: 15px; height: 15px; flex-shrink: 0; cursor: pointer;"
                      onClick={() => markItemDone.send({ key: "actions:" + item.idx })}
                    />
                    {item.action?.context ? (
                      <span style={{ fontSize: "10px", color: color.blue, background: "rgba(0,122,255,0.08)", padding: "1px 6px", borderRadius: "100px", flexShrink: "0", fontWeight: "500" }}>
                        {item.action?.context}
                      </span>
                    ) : null}
                    <span style={{ fontSize: "13px", color: color.secondaryLabel, flex: "1" }}>{item.action?.text}</span>
                  </div>
                ,
                /* Directive response row */
                ifElse(computed(() => item.type === "response"),
                  <div style={{ ...itemRowStyle, padding: "10px 0" }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
                      <span style={{
                        padding: "2px 6px", borderRadius: "4px",
                        fontSize: "10px", fontWeight: "600",
                        background: "rgba(88, 86, 214, 0.12)",
                        color: color.indigo, flexShrink: "0", marginTop: "2px",
                      }}>{item.directive?.id}</span>
                      <div style={{ flex: "1" }}>
                        <div style={{ fontSize: "13px", fontWeight: "500", color: color.label }}>
                          {/* Extract question text — read-only computed, no onClick */}
                          {computed(() => {
                            const qMatch = item.directive?.text.match(/^Re:\s*.+?\s*\u2014\s*(.+)$/);
                            return qMatch ? qMatch[1] : item.directive?.text;
                          })}
                        </div>
                        <div style={{
                          fontSize: "12px", color: color.secondaryLabel,
                          marginTop: "4px", lineHeight: "1.5",
                          whiteSpace: "pre-wrap" as const,
                        }}>
                          {item.directive?.response}
                        </div>
                        {/* Date + note link — read-only computed */}
                        {computed(() => {
                          const dateStr = item.directive?.createdAt
                            ? new Date(item.directive?.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                            : "";
                          const noteLink = item.directive?.noteUrl || "";
                          return (
                            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "6px" }}>
                              {dateStr ? (
                                <span style={{ fontSize: "11px", color: color.tertiaryLabel }}>{dateStr}</span>
                              ) : null}
                              {noteLink ? (
                                <a href={noteLink} target="_blank" style={{
                                  fontSize: "11px", color: color.blue,
                                  textDecoration: "none",
                                }}>{"📎 View note"}</a>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                ,
                /* Person row */
                ifElse(computed(() => item.type === "person"),
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
                      {item.childCount + " items"}
                    </span>
                    <span style={{ fontSize: "14px", color: color.tertiaryLabel, flexShrink: "0" }}>{">"}</span>
                  </div>
                ,
                /* Project row (default) */

                  <div>
                    <div
                      style={computed(() =>
                        selectedItem.get() === "projects:" + item.idx
                          ? {
                              ...itemRowStyle,
                              display: "flex",
                              alignItems: "center",
                              gap: "0px",
                              cursor: "pointer",
                              background: "rgba(0, 122, 255, 0.06)",
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
                      {/* Item content — click to drill in if has children, else select */}
                      <div
                        style={{ display: "flex", alignItems: "center", gap: "10px", flex: "1", cursor: "pointer" }}
                        onClick={() => item.hasChildren ? drillIntoProject.send({ id: item.id, name: item.project?.name ?? "" }) : selectItem.send({ key: "projects:" + item.idx })}
                      >
                        <span style={{ fontSize: "12px", color: color.tertiaryLabel, fontWeight: "500", minWidth: "32px", flexShrink: "0" }}>
                          {item.project?.id}
                        </span>
                        <span style={{ flex: "1" }}>{item.project?.name}</span>
                        <span
                          style={computed(() => ({
                            padding: "2px 10px",
                            borderRadius: "100px",
                            fontSize: "11px",
                            fontWeight: "500",
                            background:
                              item.project?.status === "Active"
                                ? "rgba(52, 199, 89, 0.12)"
                                : item.project?.status === "Done"
                                  ? "rgba(142, 142, 147, 0.12)"
                                  : "rgba(255, 149, 0, 0.12)",
                            color:
                              item.project?.status === "Active"
                                ? "#34c759"
                                : item.project?.status === "Done"
                                  ? "#8e8e93"
                                  : "#ff9500",
                            flexShrink: "0",
                          }))}
                        >
                          {item.project?.status}
                        </span>
                      </div>
                      {/* Note link — read-only computed, no onClick */}
                      {computed(() => {
                        const notes = projectNotesMap;
                        const link = notes[item.project?.name ?? ""];
                        if (!link) return null;
                        return (
                          <a href={link} target="_blank" style={{ textDecoration: "none", fontSize: "16px", flexShrink: "0", cursor: "pointer", marginLeft: "4px" }}>
                            {"📎"}
                          </a>
                        );
                      })}
                      {/* Drill-in chevron */}
                      {item.hasChildren ? (
                        <span style={{ fontSize: "14px", color: color.tertiaryLabel, paddingLeft: "8px", flexShrink: "0", cursor: "pointer" }} onClick={() => drillIntoProject.send({ id: item.id, name: item.project?.name ?? "" })}>{">"}</span>
                      ) : null}
                    </div>
                    {/* Selection toolbar — ifElse for onClick safety */}
                    {ifElse(
                      computed(() => selectedItem.get() === "projects:" + item.idx),
                      <div style={{ display: "flex", gap: "8px", padding: "6px 0 8px", flexWrap: "wrap" as const }}>
                        <div style={actionBtnDone} onClick={() => markItemDone.send({ key: "projects:" + item.idx })}>{"✓ Done"}</div>
                        <div style={actionBtnDelete} onClick={() => deleteItem.send({ key: "projects:" + item.idx })}>{"✕ Delete"}</div>
                        <div style={actionBtnDirective} onClick={openItemDirective}>{"→ Directive"}</div>
                        {!item.hasChildren ? (
                          <div style={actionBtnAdd} onClick={() => drillAndAddSubproject.send({ id: item.id, name: item.project?.name ?? "" })}>+ Subproject</div>
                        ) : null}
                      </div>,
                      null,
                    )}
                  </div>
                ))),
            )}
            {/* Add project / subproject — ifElse for onClick + $value safety */}
            {ifElse(
              addItemOpen,
              <div style={{ display: "flex", gap: "8px", marginTop: "10px", alignItems: "center" }}>
                <ct-textarea
                  $value={addItemDraft}
                  placeholder={computed(() => {
                    const crumbs = breadcrumbCrumbs;
                    return crumbs.length > 0 ? "New subproject..." : "New project...";
                  })}
                  rows={1}
                  style="flex: 1; border-radius: 10px; font-size: 14px;"
                />
                <div style={{ padding: "7px 16px", borderRadius: "100px", fontSize: "13px", fontWeight: "600", background: color.blue, color: "#fff", cursor: "pointer", flexShrink: "0" }} onClick={sendAddItem}>Add</div>
                <div style={{ padding: "7px 10px", borderRadius: "100px", fontSize: "13px", color: color.secondaryLabel, cursor: "pointer", flexShrink: "0" }} onClick={() => { addItemOpen.set(false); addItemDraft.set(""); }}>Cancel</div>
              </div>,
              <div style={{ marginTop: "10px", display: "inline-flex", alignItems: "center", gap: "5px", cursor: "pointer", color: color.blue, fontSize: "13px", fontWeight: "500", padding: "4px 0" }} onClick={openAddItem}>
                <span style={{ fontSize: "17px", fontWeight: "300", lineHeight: "1" }}>+</span>
                <span>{computed(() => {
                  const crumbs = breadcrumbCrumbs;
                  return crumbs.length > 0 ? "New Subproject" : "New Project";
                })}</span>
              </div>,
            )}
          </div>
        </div>
      ),
    };
  },
);

export default GTDProjects;
