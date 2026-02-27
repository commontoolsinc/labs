/// <cts-enable />
import {
  action,
  computed,
  type Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

// ===== Types =====

interface Idea {
  id: string;
  text: string;
  done: boolean;
}

interface SharedProject {
  id: string;
  title: string;
  done: boolean;
}

interface Memory {
  id: string;
  date: string;
  text: string;
}

interface ZoraInput {
  nextIdeas: Writable<Default<Idea[], []>>;
  projects: Writable<Default<SharedProject[], []>>;
  memories: Writable<Default<Memory[], []>>;
}

interface ZoraOutput {
  [NAME]: string;
  [UI]: VNode;
  nextIdeas: Idea[];
  projects: SharedProject[];
  memories: Memory[];
}

// ===== Design Tokens =====

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
  pink: "#ff375f",
  purple: "#af52de",
  amber: "#ff9f0a",
  green: "#34c759",
};

// ===== Pattern =====

const Zora = pattern<ZoraInput, ZoraOutput>(({ nextIdeas, projects, memories }) => {
  // UI state
  const activeTab = Writable.of<string>("ideas");
  const ideaDraft = Writable.of<string>("");
  const projectDraft = Writable.of<string>("");
  const memoryDraft = Writable.of<string>("");

  // Tab navigation
  const setTab = action(({ tab }: { tab: string }) => {
    activeTab.set(tab);
  });

  // Ideas actions
  const addIdea = action(() => {
    const text = ideaDraft.get().trim();
    if (!text) return;
    nextIdeas.set([...nextIdeas.get(), { id: `i-${Date.now()}`, text, done: false }]);
    ideaDraft.set("");
  });

  const toggleIdea = action(({ id }: { id: string }) => {
    nextIdeas.set(
      nextIdeas.get().map((i: Idea) => (i.id === id ? { ...i, done: !i.done } : i)),
    );
  });

  const clearDoneIdeas = action(() => {
    nextIdeas.set(nextIdeas.get().filter((i: Idea) => !i.done));
  });

  // Projects actions
  const addProject = action(() => {
    const title = projectDraft.get().trim();
    if (!title) return;
    projects.set([...projects.get(), { id: `p-${Date.now()}`, title, done: false }]);
    projectDraft.set("");
  });

  const toggleProject = action(({ id }: { id: string }) => {
    projects.set(
      projects.get().map((p: SharedProject) => (p.id === id ? { ...p, done: !p.done } : p)),
    );
  });

  const clearDoneProjects = action(() => {
    projects.set(projects.get().filter((p: SharedProject) => !p.done));
  });

  // Memories actions
  const addMemory = action(() => {
    const text = memoryDraft.get().trim();
    if (!text) return;
    const date = new Date().toISOString().slice(0, 10);
    memories.set([{ id: `m-${Date.now()}`, date, text }, ...memories.get()]);
    memoryDraft.set("");
  });

  // Single computed for entire UI — avoids ifElse reactive cell overhead
  const ui = computed(() => {
    const tab = activeTab.get();
    const allIdeas = nextIdeas.get();
    const openIdeas = allIdeas.filter((i: Idea) => !i.done);
    const doneIdeas = allIdeas.filter((i: Idea) => i.done);
    const allProjects = projects.get();
    const activeProjects = allProjects.filter((p: SharedProject) => !p.done);
    const doneProjects = allProjects.filter((p: SharedProject) => p.done);
    const allMemories = memories.get();

    // ---- Tab: Together Next ----
    const ideasContent =
      tab === "ideas" ? (
        <div>
          <ct-textarea
            $value={ideaDraft}
            placeholder="What would Zora love to do?"
            rows={2}
            style="width: 100%; border-radius: 10px; font-size: 14px;"
          />
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginTop: "8px",
            }}
          >
            <div
              onClick={addIdea}
              style={{
                padding: "6px 16px",
                borderRadius: "100px",
                fontSize: "13px",
                fontWeight: "600",
                background: color.pink,
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Add
            </div>
          </div>
          {openIdeas.length === 0 && doneIdeas.length === 0 ? (
            <div
              style={{
                color: color.tertiaryLabel,
                fontSize: "14px",
                textAlign: "center" as const,
                padding: "24px 0",
              }}
            >
              No ideas yet — what would Zora enjoy?
            </div>
          ) : null}
          {openIdeas.map((idea: Idea) => (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "10px",
                padding: "10px 0",
                borderBottom: "0.5px solid " + color.separator,
              }}
            >
              <div
                onClick={() => toggleIdea.send({ id: idea.id })}
                style={{
                  width: "20px",
                  height: "20px",
                  borderRadius: "50%",
                  border: "2px solid " + color.pink,
                  flexShrink: "0",
                  marginTop: "2px",
                  cursor: "pointer",
                }}
              />
              <span
                style={{
                  fontSize: "14px",
                  color: color.label,
                  flex: "1",
                  lineHeight: "1.5",
                }}
              >
                {idea.text}
              </span>
            </div>
          ))}
          {doneIdeas.length > 0 ? (
            <div style={{ marginTop: "16px" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "6px",
                }}
              >
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: "600",
                    color: color.tertiaryLabel,
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.5px",
                  }}
                >
                  Done ({doneIdeas.length})
                </div>
                <div
                  onClick={clearDoneIdeas}
                  style={{
                    fontSize: "11px",
                    color: color.pink,
                    cursor: "pointer",
                    fontWeight: "500",
                  }}
                >
                  Clear
                </div>
              </div>
              {doneIdeas.map((idea: Idea) => (
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "10px",
                    padding: "8px 0",
                    borderBottom: "0.5px solid " + color.separator,
                  }}
                >
                  <div
                    onClick={() => toggleIdea.send({ id: idea.id })}
                    style={{
                      width: "20px",
                      height: "20px",
                      borderRadius: "50%",
                      background: color.green,
                      flexShrink: "0",
                      marginTop: "2px",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#fff",
                      fontSize: "11px",
                    }}
                  >
                    ✓
                  </div>
                  <span
                    style={{
                      fontSize: "14px",
                      color: color.tertiaryLabel,
                      flex: "1",
                      textDecoration: "line-through",
                    }}
                  >
                    {idea.text}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null;

    // ---- Tab: Projects ----
    const projectsContent =
      tab === "projects" ? (
        <div>
          <ct-textarea
            $value={projectDraft}
            placeholder="New shared project (e.g. ComputerCraft turtle bot)..."
            rows={2}
            style="width: 100%; border-radius: 10px; font-size: 14px;"
          />
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginTop: "8px",
            }}
          >
            <div
              onClick={addProject}
              style={{
                padding: "6px 16px",
                borderRadius: "100px",
                fontSize: "13px",
                fontWeight: "600",
                background: color.purple,
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Add
            </div>
          </div>
          {activeProjects.length === 0 && doneProjects.length === 0 ? (
            <div
              style={{
                color: color.tertiaryLabel,
                fontSize: "14px",
                textAlign: "center" as const,
                padding: "24px 0",
              }}
            >
              No projects yet — what are you building together?
            </div>
          ) : null}
          {activeProjects.map((p: SharedProject) => (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                padding: "10px 0",
                borderBottom: "0.5px solid " + color.separator,
              }}
            >
              <div
                onClick={() => toggleProject.send({ id: p.id })}
                style={{
                  width: "20px",
                  height: "20px",
                  borderRadius: "6px",
                  border: "2px solid " + color.purple,
                  flexShrink: "0",
                  cursor: "pointer",
                }}
              />
              <span
                style={{
                  fontSize: "14px",
                  color: color.label,
                  flex: "1",
                  fontWeight: "500",
                }}
              >
                {p.title}
              </span>
            </div>
          ))}
          {doneProjects.length > 0 ? (
            <div style={{ marginTop: "16px" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "6px",
                }}
              >
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: "600",
                    color: color.tertiaryLabel,
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.5px",
                  }}
                >
                  Done ({doneProjects.length})
                </div>
                <div
                  onClick={clearDoneProjects}
                  style={{
                    fontSize: "11px",
                    color: color.purple,
                    cursor: "pointer",
                    fontWeight: "500",
                  }}
                >
                  Archive
                </div>
              </div>
              {doneProjects.map((p: SharedProject) => (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "8px 0",
                    borderBottom: "0.5px solid " + color.separator,
                  }}
                >
                  <div
                    onClick={() => toggleProject.send({ id: p.id })}
                    style={{
                      width: "20px",
                      height: "20px",
                      borderRadius: "6px",
                      background: color.green,
                      flexShrink: "0",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#fff",
                      fontSize: "11px",
                    }}
                  >
                    ✓
                  </div>
                  <span
                    style={{
                      fontSize: "14px",
                      color: color.tertiaryLabel,
                      flex: "1",
                      textDecoration: "line-through",
                    }}
                  >
                    {p.title}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null;

    // ---- Tab: Memories ----
    const memoriesContent =
      tab === "memories" ? (
        <div>
          <ct-textarea
            $value={memoryDraft}
            placeholder="Something she said, a moment to remember, a milestone..."
            rows={3}
            style="width: 100%; border-radius: 10px; font-size: 14px;"
          />
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginTop: "8px",
            }}
          >
            <div
              onClick={addMemory}
              style={{
                padding: "6px 16px",
                borderRadius: "100px",
                fontSize: "13px",
                fontWeight: "600",
                background: color.amber,
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Save
            </div>
          </div>
          {allMemories.length === 0 ? (
            <div
              style={{
                color: color.tertiaryLabel,
                fontSize: "14px",
                textAlign: "center" as const,
                padding: "24px 0",
              }}
            >
              No memories yet — capture something special.
            </div>
          ) : null}
          {allMemories.map((m: Memory) => (
            <div
              style={{
                padding: "12px 0",
                borderBottom: "0.5px solid " + color.separator,
              }}
            >
              <div
                style={{
                  fontSize: "11px",
                  color: color.tertiaryLabel,
                  marginBottom: "4px",
                  fontWeight: "500",
                }}
              >
                {m.date}
              </div>
              <div
                style={{
                  fontSize: "14px",
                  color: color.label,
                  lineHeight: "1.6",
                }}
              >
                {m.text}
              </div>
            </div>
          ))}
        </div>
      ) : null;

    const tabBtn = (id: string, label: string, accent: string) => (
      <div
        onClick={() => setTab.send({ tab: id })}
        style={{
          padding: "7px 14px",
          borderRadius: "100px",
          fontSize: "13px",
          fontWeight: tab === id ? "600" : "400",
          background: tab === id ? accent : color.fillPrimary,
          color: tab === id ? "#fff" : color.secondaryLabel,
          cursor: "pointer",
          userSelect: "none" as const,
        }}
      >
        {label}
      </div>
    );

    return (
      <div
        style={{
          fontFamily: font,
          maxWidth: "520px",
          margin: "0 auto",
          padding: "20px 16px",
          background: color.background,
          minHeight: "100vh",
        }}
      >
        {/* Header */}
        <div style={{ marginBottom: "24px" }}>
          <div
            style={{
              fontSize: "32px",
              fontWeight: "700",
              color: color.label,
              letterSpacing: "-0.5px",
            }}
          >
            Zora
          </div>
          <div
            style={{
              fontSize: "14px",
              color: color.secondaryLabel,
              marginTop: "2px",
            }}
          >
            9 · Harker · ComputerCraft
          </div>
        </div>

        {/* Tab bar */}
        <div
          style={{
            display: "flex",
            gap: "8px",
            marginBottom: "16px",
            flexWrap: "wrap" as const,
          }}
        >
          {tabBtn("ideas", "Together Next", color.pink)}
          {tabBtn("projects", "Projects", color.purple)}
          {tabBtn("memories", "Memories", color.amber)}
        </div>

        {/* Content card */}
        <div
          style={{
            background: color.secondaryBg,
            borderRadius: "16px",
            padding: "16px",
          }}
        >
          {ideasContent}
          {projectsContent}
          {memoriesContent}
        </div>
      </div>
    );
  });

  return {
    [NAME]: "Zora",
    nextIdeas,
    projects,
    memories,
    [UI]: ui,
  };
});

export default Zora;
