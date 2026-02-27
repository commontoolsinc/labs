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

interface Reply {
  author: string;
  text: string;
  at: string;
}

interface Question {
  id: string;
  source: string;
  category: string;
  question: string;
  context: string;
  options: string[];
  priority: string;
  status: string;
  answer: string;
  answeredBy: string;
  answeredAt: string;
  replies: Reply[];
}

interface SyncHealth {
  consecutiveFailures: number;
  minutesSinceSuccess: number;
}

interface StatusData {
  inboxCount: number;
  projectCount: number;
  waitingForCount: number;
  nextActionCount: number;
  lastSync: string;
  spaceName?: string;
  calendarPieceId?: string;
  syncHealth?: SyncHealth;
}

interface InboxItem {
  text: string;
  done: boolean;
}
interface Project {
  id: string;
  name: string;
  status: string;
  parentId: string;
  childIds: string[];
}
interface WaitingItem {
  entity: string;
  description: string;
  projectId: string;
}
interface NextAction {
  context: string;
  section: string;
  text: string;
  projectId: string;
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
  createdAt?: string;
  status: string;
  response?: string;
  assignedTo?: string;
  noteUrl?: string;
  sourceQuestion?: string;
}

interface ThingItem {
  name: string;
  type: string;
  children?: ThingItem[];
  itemCount?: number;
}

interface Items {
  inbox: InboxItem[];
  projects: Project[];
  people: Person[];
  waiting: WaitingItem[];
  actions: NextAction[];
  things: ThingItem[];
}

interface UserAction {
  type: string;
  panel?: string;
  text?: string;
  newText?: string;
  questionId?: string;
  directiveId?: string;
  answer?: string;
  author?: string;
  target?: string;
  ts: string;
}

interface DashboardInput {
  questions: Writable<Default<Question[], []>>;
  status: Writable<
    Default<
      StatusData,
      {
        inboxCount: 0;
        projectCount: 0;
        waitingForCount: 0;
        nextActionCount: 0;
        lastSync: "";
        spaceName: "";
        calendarPieceId: "";
      }
    >
  >;
  items: Writable<
    Default<
      Items,
      {
        inbox: [];
        projects: [];
        people: [];
        waiting: [];
        actions: [];
        things: [];
      }
    >
  >;
  directives: Writable<Default<Directive[], []>>;
}

interface DashboardOutput {
  [NAME]: string;
  [UI]: VNode;
  userActions: UserAction[];
  pendingCount: number;
  answeredCount: number;
}

// ===== Apple-style Design Tokens =====

const font =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif";

const color = {
  label: "#1d1d1f",
  secondaryLabel: "#86868b",
  tertiaryLabel: "#aeaeb2",
  separator: "rgba(60, 60, 67, 0.12)",
  fillPrimary: "rgba(120, 120, 128, 0.12)",
  fillSecondary: "rgba(120, 120, 128, 0.06)",
  fillTertiary: "rgba(120, 120, 128, 0.04)",
  background: "#ffffff",
  secondaryBg: "#f5f5f7",
  blue: "#007aff",
  green: "#34c759",
  orange: "#ff9500",
  red: "#ff3b30",
  purple: "#af52de",
  teal: "#5ac8fa",
  indigo: "#5856d6",
  pink: "#ff2d55",
};


const categoryTints: Record<string, { bg: string; fg: string }> = {
  people: { bg: "rgba(175, 82, 222, 0.12)", fg: "#af52de" },
  projects: { bg: "rgba(0, 122, 255, 0.12)", fg: "#007aff" },
  places: { bg: "rgba(52, 199, 89, 0.12)", fg: "#34c759" },
  things: { bg: "rgba(255, 149, 0, 0.12)", fg: "#ff9500" },
  work: { bg: "rgba(255, 59, 48, 0.12)", fg: "#ff3b30" },
  general: { bg: "rgba(142, 142, 147, 0.12)", fg: "#8e8e93" },
  review: { bg: "rgba(90, 200, 250, 0.12)", fg: "#5ac8fa" },
  inbox: { bg: "rgba(255, 45, 85, 0.12)", fg: "#ff2d55" },
};

const priorityDots: Record<string, string> = {
  high: color.red,
  medium: color.orange,
  low: color.tertiaryLabel,
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
  background: "rgba(175, 82, 222, 0.12)",
  color: "#af52de",
  cursor: "pointer",
};

const actionBtnDismiss = {
  padding: "5px 14px",
  borderRadius: "100px",
  fontSize: "12px",
  fontWeight: "600",
  background: "rgba(142, 142, 147, 0.12)",
  color: "#8e8e93",
  cursor: "pointer",
  flexShrink: "0",
};

const actionBtnProject = {
  padding: "5px 14px",
  borderRadius: "100px",
  fontSize: "12px",
  fontWeight: "600",
  background: "rgba(0, 122, 255, 0.12)",
  color: "#007aff",
  cursor: "pointer",
};

const actionBtnPerson = {
  padding: "5px 14px",
  borderRadius: "100px",
  fontSize: "12px",
  fontWeight: "600",
  background: "rgba(175, 82, 222, 0.12)",
  color: "#af52de",
  cursor: "pointer",
};

const actionBtnThing = {
  padding: "5px 14px",
  borderRadius: "100px",
  fontSize: "12px",
  fontWeight: "600",
  background: "rgba(255, 149, 0, 0.12)",
  color: "#ff9500",
  cursor: "pointer",
};

const cssId = (prefix: string, key: string) =>
  prefix + key.replace(/[^a-zA-Z0-9]/g, "_");

const noticeInfo = (text: string): { emoji: string; isNotice: boolean } => {
  if (/^D-\d+ complete/i.test(text)) return { emoji: "🎉", isNotice: true };
  if (/^D-\d+ needs input/i.test(text)) return { emoji: "❓", isNotice: true };
  if (/^\[REVIEW\]/.test(text)) return { emoji: "👀", isNotice: true };
  if (/^\[DEPLOYED\]/.test(text)) return { emoji: "🚀", isNotice: true };
  if (/^\[REJECTED\]/.test(text)) return { emoji: "❌", isNotice: true };
  return { emoji: "", isNotice: false };
};

// ===== Pattern =====

const GTDDashboard = pattern<DashboardInput, DashboardOutput>(
  ({ questions, status, items, directives }) => {
    const filterStatus = Writable.of<"all" | "pending" | "answered">(
      "pending",
    );
    const selectedId = Writable.of<string>("");
    const draftAnswer = Writable.of<string>("");
    const expandedPanel = Writable.of<string>("");
    const inboxDraft = Writable.of<string>("");
    // Command state
    const dispatchOpen = Writable.of<boolean>(false);
    const dispatchDraft = Writable.of<string>("");


    // Breadcrumb navigation state for Projects panel
    // Stores "id|name" strings — simple array to avoid reactive serialization issues
    const projectBreadcrumbs = Writable.of<string[]>([]);

    // Breadcrumb navigation state for People panel
    const peopleBreadcrumbs = Writable.of<string[]>([]);

    // Breadcrumb navigation state for Things panel
    const thingsBreadcrumbs = Writable.of<string[]>([]);

    // Show/hide Done and Archived items (defaults to hidden)
    const showCompleted = Writable.of<boolean>(false);

    // Sync button state
    const syncPending = Writable.of<boolean>(false);
    const syncTriggeredAt = Writable.of<string>("");

    // Breadcrumb directive state (for filing directives against drilled-in items)
    const breadcrumbDirectiveOpen = Writable.of<boolean>(false);
    const breadcrumbDirectiveDraft = Writable.of<string>("");
    const breadcrumbDirectivePrefix = Writable.of<string>("");
    const breadcrumbDirectiveContext = Writable.of<string>("");

    // Weather removed — fetchData async requests caused memory spikes in shell

    // Actions queue — all user mutations go here, sync script processes them
    const userActions = Writable.of<UserAction[]>([]);

    // Per-item selection state
    const selectedItem = Writable.of<string>("");
    const itemDirectiveDraft = Writable.of<string>("");
    const itemDirectiveOpen = Writable.of<boolean>(false);

    // Sub-project creation state
    const subProjectOpen = Writable.of<boolean>(false);
    const subProjectDraft = Writable.of<string>("");

    // Inline edit state — STRIPPED (D-106 caused reactive loop / "Too many iterations")
    // TODO: re-implement with lighter reactive footprint

    // Add item state
    const addItemOpen = Writable.of<boolean>(false);
    const addItemDraft = Writable.of<string>("");
    const addItemType = Writable.of<string>("");  // "project" | "action" | "" (for people sub-items)

    // Display computeds — read-only inputs filtered/augmented by local actions
    // Key invariant: sync push is authoritative. After a sync, the file data is truth.
    // Only userActions that happened AFTER the last sync should augment the display.
    const displayInbox = computed(() => {
      const raw = (items.get()?.inbox || []).filter(Boolean) as InboxItem[];
      const acts = (userActions.get() || []).filter(Boolean);
      const lastSyncTs = status.get()?.lastSync || "";
      const adds = acts.filter((a: UserAction) => a.type === "add" && a.panel === "inbox" && (!lastSyncTs || a.ts > lastSyncTs));
      // Build dels set using latest-action-wins (supports undone toggle for 🎉 items)
      const doneRelatedActs = acts.filter((a: UserAction) =>
        (a.type === "delete" || a.type === "done" || a.type === "undone") &&
        a.panel === "inbox" && (!lastSyncTs || a.ts > lastSyncTs) && a.text
      );
      const latestDoneAct: Record<string, { type: string; ts: string }> = {};
      for (const a of doneRelatedActs) {
        const prev = latestDoneAct[a.text!];
        if (!prev || a.ts > prev.ts) latestDoneAct[a.text!] = { type: a.type, ts: a.ts };
      }
      const dels = new Set(Object.entries(latestDoneAct).filter(([, v]) => v.type === "done" || v.type === "delete").map(([k]) => k));
      const undones = new Set(Object.entries(latestDoneAct).filter(([, v]) => v.type === "undone").map(([k]) => k));
      // Build edits map: oldText -> newText (for inline editing)
      const edits: Record<string, string> = {};
      for (const a of acts) { if (a.type === "edit" && a.panel === "inbox" && a.text && a.newText) edits[a.text] = a.newText; }
      // 🎉 directive-complete items: keep visible with strikethrough until next sync; others filter immediately
      const filtered = raw
        .filter((i: InboxItem) => !dels.has(i.text) || i.text.startsWith("🎉"))
        .map((i: InboxItem) => {
          const newText = edits[i.text] || i.text;
          const newDone = (i.done && !undones.has(i.text)) || dels.has(i.text);
          if (newText === i.text && newDone === i.done) return i;
          return { ...i, text: newText, done: newDone };
        });
      // Deduplicate: skip adds already present in raw (sync may have persisted them)
      const existing = new Set(raw.map((i: InboxItem) => i.text));
      const newAdds = adds.filter((a: UserAction) => !existing.has(a.text || "") && !dels.has(a.text || ""));
      return [...filtered, ...newAdds.map((a: UserAction) => ({ text: a.text || "", done: false }))];
    });

    const displayPeople = computed(() => {
      const raw = (items.get()?.people || []).filter(Boolean) as Person[];
      const acts = (userActions.get() || []).filter(Boolean);
      const dels = new Set(acts.filter((a: UserAction) => (a.type === "delete" || a.type === "done") && a.panel === "people").map((a: UserAction) => a.text || ""));
      const edits: Record<string, string> = {};
      for (const a of acts) { if (a.type === "edit" && a.panel === "people" && a.text && a.newText) edits[a.text] = a.newText; }
      return raw.filter((p: Person) => !dels.has(p.name)).map((p: Person) => edits[p.name] ? { ...p, name: edits[p.name] } : p);
    });

    const displayWaiting = computed(() => {
      const raw = (items.get()?.waiting || []).filter(Boolean) as WaitingItem[];
      const acts = (userActions.get() || []).filter(Boolean);
      const lastSyncTs = status.get()?.lastSync || "";
      const dels = new Set(acts.filter((a: UserAction) => (a.type === "delete" || a.type === "done") && a.panel === "waiting").map((a: UserAction) => a.text || ""));
      const adds = acts.filter((a: UserAction) => a.type === "add" && a.panel === "waiting" && (!lastSyncTs || a.ts > lastSyncTs));
      const edits: Record<string, string> = {};
      for (const a of acts) { if (a.type === "edit" && a.panel === "waiting" && a.text && a.newText) edits[a.text] = a.newText; }
      const filtered = raw.filter((w: WaitingItem) => w && !dels.has(w.entity)).map((w: WaitingItem) => edits[w.entity] ? { ...w, entity: edits[w.entity] } : w);
      const existing = new Set(raw.map((w: WaitingItem) => w.entity));
      const newAdds = adds.filter((a: UserAction) => !existing.has(a.text || ""));
      return [...filtered, ...newAdds.map((a: UserAction) => ({ entity: a.text || "", description: "", projectId: "" }))];
    });

    const displayActions = computed(() => {
      const raw = (items.get()?.actions || []).filter(Boolean) as NextAction[];
      const acts = (userActions.get() || []).filter(Boolean);
      const dels = new Set(acts.filter((a: UserAction) => (a.type === "delete" || a.type === "done") && a.panel === "actions").map((a: UserAction) => a.text || ""));
      const edits: Record<string, string> = {};
      for (const a of acts) { if (a.type === "edit" && a.panel === "actions" && a.text && a.newText) edits[a.text] = a.newText; }
      return raw.filter((a: NextAction) => !dels.has(a.text)).map((a: NextAction) => edits[a.text] ? { ...a, text: edits[a.text] } : a);
    });

    const displayProjects = computed(() => {
      const raw = (items.get()?.projects || []).filter(Boolean) as Project[];
      const acts = (userActions.get() || []).filter(Boolean);
      const lastSyncTs = status.get()?.lastSync || "";
      const adds = acts.filter((a: UserAction) => a.type === "add" && a.panel === "projects" && (!lastSyncTs || a.ts > lastSyncTs));
      const dels = new Set(acts.filter((a: UserAction) => (a.type === "delete" || a.type === "done") && a.panel === "projects").map((a: UserAction) => (a.text || "").toLowerCase()));
      const edits: Record<string, string> = {};
      for (const a of acts) { if (a.type === "edit" && a.panel === "projects" && a.text && a.newText) edits[a.text.toLowerCase()] = a.newText; }
      const filtered = raw.filter((p: Project) => !dels.has(p.name.toLowerCase())).map((p: Project) => edits[p.name.toLowerCase()] ? { ...p, name: edits[p.name.toLowerCase()] } : p);
      const existing = new Set(raw.map((p: Project) => p.name.toLowerCase()));
      const newAdds = adds
        .filter((a: UserAction) => !existing.has((a.text || "").toLowerCase()) && !dels.has((a.text || "").toLowerCase()))
        .map((a: UserAction) => ({ id: "", name: (a.text || "").split(" ").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "), status: "Active", childIds: [], parentId: "" } as Project));
      // Optimistic subproject adds: parse pending "Add subproject to X: Y" directives
      const subAdds: Project[] = [];
      const addedSubNames = new Set<string>();
      for (const a of acts) {
        if (a.type !== "directive") continue;
        const m = (a.text || "").match(/^Add subproject to (.+): (.+)$/);
        if (!m) continue;
        const parentName = m[1].trim();
        const subName = m[2].trim();
        const parent = raw.find((p: Project) => p.name.toLowerCase() === parentName.toLowerCase());
        if (!parent) continue;
        if (existing.has(subName.toLowerCase()) || addedSubNames.has(subName.toLowerCase())) continue;
        addedSubNames.add(subName.toLowerCase());
        subAdds.push({ id: "", name: subName, status: "Active", childIds: [], parentId: parent.id } as Project);
      }
      return [...filtered, ...newAdds, ...subAdds];
    });

    const displayQuestions = computed(() => {
      const raw = questions.get();
      const acts = (userActions.get() || []).filter(Boolean);
      return raw.map((q: Question) => {
        const dismiss = acts.find((a: UserAction) => a.type === "dismiss" && a.questionId === q.id);
        if (dismiss) return { ...q, status: "dismissed", answer: "[dismissed]", answeredBy: "human-lead", answeredAt: dismiss.ts };
        const ans = acts.find((a: UserAction) => a.type === "answer" && a.questionId === q.id);
        if (ans) return { ...q, status: "directed", answer: ans.answer || "", answeredBy: ans.author || "", answeredAt: ans.ts };
        const replies = acts.filter((a: UserAction) => a.type === "reply" && a.questionId === q.id);
        if (replies.length > 0) {
          const existingReplies = new Set((q.replies || []).map((r: Reply) => r.text + "|" + r.at));
          const newReplies = replies.filter((r: UserAction) => !existingReplies.has((r.text || "") + "|" + r.ts));
          if (newReplies.length > 0) return { ...q, status: "directed", replies: [...(q.replies || []), ...newReplies.map((r: UserAction) => ({ text: r.text || "", author: r.author || "", at: r.ts }))] };
        }
        return q;
      });
    });

    const pendingCount = computed(
      () => displayQuestions.filter((q: Question) => q.status === "pending").length,
    );

    const answeredCount = computed(
      () => displayQuestions.filter((q: Question) => q.status === "answered").length,
    );

    const selectedQuestionId = computed(() => {
      const id = selectedId.get();
      if (!id) return "";
      const q = displayQuestions.find((qq: Question) => qq.id === id);
      return q ? q.id : "";
    });

    const selectedQuestionText = computed(() => {
      const id = selectedId.get();
      if (!id) return "";
      const q = displayQuestions.find((qq: Question) => qq.id === id);
      return q ? q.question : "";
    });

    // Stat card computed styles — one computed per panel (no factory functions in pattern scope)
    const cardStyleInbox = computed(() => ({ background: expandedPanel.get() === "inbox" ? "rgba(0, 122, 255, 0.08)" : color.fillPrimary, borderRadius: "12px", padding: "12px 14px", cursor: "pointer", transition: "background 0.2s ease", border: expandedPanel.get() === "inbox" ? "1px solid rgba(0, 122, 255, 0.2)" : "1px solid transparent" }));
    const cardStyleProjects = computed(() => ({ background: expandedPanel.get() === "projects" ? "rgba(0, 122, 255, 0.08)" : color.fillPrimary, borderRadius: "12px", padding: "12px 14px", cursor: "pointer", transition: "background 0.2s ease", border: expandedPanel.get() === "projects" ? "1px solid rgba(0, 122, 255, 0.2)" : "1px solid transparent" }));
    const cardStylePeople = computed(() => ({ background: expandedPanel.get() === "people" ? "rgba(0, 122, 255, 0.08)" : color.fillPrimary, borderRadius: "12px", padding: "12px 14px", cursor: "pointer", transition: "background 0.2s ease", border: expandedPanel.get() === "people" ? "1px solid rgba(0, 122, 255, 0.2)" : "1px solid transparent" }));
    const cardStyleThings = computed(() => ({ background: expandedPanel.get() === "things" ? "rgba(0, 122, 255, 0.08)" : color.fillPrimary, borderRadius: "12px", padding: "12px 14px", cursor: "pointer", transition: "background 0.2s ease", border: expandedPanel.get() === "things" ? "1px solid rgba(0, 122, 255, 0.2)" : "1px solid transparent" }));
    const chevronStyleInbox = computed(() => ({ fontSize: "10px", color: color.tertiaryLabel, transition: "transform 0.2s ease", transform: expandedPanel.get() === "inbox" ? "rotate(90deg)" : "rotate(0deg)", marginLeft: "auto", flexShrink: "0" }));
    const chevronStyleProjects = computed(() => ({ fontSize: "10px", color: color.tertiaryLabel, transition: "transform 0.2s ease", transform: expandedPanel.get() === "projects" ? "rotate(90deg)" : "rotate(0deg)", marginLeft: "auto", flexShrink: "0" }));
    const chevronStylePeople = computed(() => ({ fontSize: "10px", color: color.tertiaryLabel, transition: "transform 0.2s ease", transform: expandedPanel.get() === "people" ? "rotate(90deg)" : "rotate(0deg)", marginLeft: "auto", flexShrink: "0" }));
    const chevronStyleThings = computed(() => ({ fontSize: "10px", color: color.tertiaryLabel, transition: "transform 0.2s ease", transform: expandedPanel.get() === "things" ? "rotate(90deg)" : "rotate(0deg)", marginLeft: "auto", flexShrink: "0" }));

    const togglePanel = action(({ panel }: { panel: string }) => {
      expandedPanel.set(panel);
      addItemOpen.set(false);
      addItemDraft.set("");
      addItemType.set("");
      if (panel === "projects") projectBreadcrumbs.set([]);
      if (panel === "people") peopleBreadcrumbs.set([]);
      if (panel === "things") thingsBreadcrumbs.set([]);
    });

    const addInboxItem = action(() => {
      const text = inboxDraft.get().trim();
      if (!text) return;
      const now = new Date().toISOString();
      userActions.set([...userActions.get(), { type: "add", panel: "inbox", text, ts: now }]);
      inboxDraft.set("");
    });

    const toggleDispatch = action(() => {
      const current = dispatchOpen.get();
      dispatchOpen.set(!current);
      if (current) {
        dispatchDraft.set("");
      }
    });

    const sendDispatch = action(() => {
      const text = dispatchDraft.get().trim();
      if (!text) return;
      const now = new Date().toISOString();
      userActions.set([...userActions.get(), { type: "directive", target: "system", text: "Command: " + text, ts: now }]);
      dispatchDraft.set("");
      dispatchOpen.set(false);
      // Auto-sync after sending directive so dispatch picks it up immediately
      syncPending.set(true);
      syncTriggeredAt.set(new Date().toISOString());
      fetch("http://127.0.0.1:9876/sync", { method: "POST", mode: "cors" });
    });

    const syncNow = action(() => {
      syncPending.set(true);
      syncTriggeredAt.set(new Date().toISOString());
      fetch("http://127.0.0.1:9876/sync", { method: "POST", mode: "cors" });
    });

    const drillIntoProject = action(({ id, name }: { id: string, name: string }) => {
      const crumbs = [...(projectBreadcrumbs.get() || [])];
      crumbs.push(id + "|" + name);
      projectBreadcrumbs.set(crumbs);
      selectedItem.set("");
      itemDirectiveOpen.set(false);
      itemDirectiveDraft.set("");
      subProjectOpen.set(false);
      subProjectDraft.set("");
      breadcrumbDirectiveOpen.set(false);
      breadcrumbDirectiveDraft.set("");
    });

    const toggleShowCompleted = action(() => {
      showCompleted.set(!showCompleted.get());
    });

    const navigateBreadcrumb = action(({ depth }: { depth: number }) => {
      // depth -1 = root (clear all), 0 = first crumb, etc.
      if (depth < 0) {
        projectBreadcrumbs.set([]);
      } else {
        const crumbs = [...(projectBreadcrumbs.get() || [])];
        projectBreadcrumbs.set(crumbs.slice(0, depth + 1));
      }
      selectedItem.set("");
      itemDirectiveOpen.set(false);
      itemDirectiveDraft.set("");
      subProjectOpen.set(false);
      subProjectDraft.set("");
      breadcrumbDirectiveOpen.set(false);
      breadcrumbDirectiveDraft.set("");
    });

    const drillIntoPerson = action(({ id, name }: { id: string, name: string }) => {
      const crumbs = [...(peopleBreadcrumbs.get() || [])];
      crumbs.push(id + "|" + name);
      peopleBreadcrumbs.set(crumbs);
      selectedItem.set("");
      itemDirectiveOpen.set(false);
      itemDirectiveDraft.set("");
      breadcrumbDirectiveOpen.set(false);
      breadcrumbDirectiveDraft.set("");
    });

    const navigatePeopleBreadcrumb = action(({ depth }: { depth: number }) => {
      if (depth < 0) {
        peopleBreadcrumbs.set([]);
      } else {
        const crumbs = [...(peopleBreadcrumbs.get() || [])];
        peopleBreadcrumbs.set(crumbs.slice(0, depth + 1));
      }
      selectedItem.set("");
      itemDirectiveOpen.set(false);
      itemDirectiveDraft.set("");
      breadcrumbDirectiveOpen.set(false);
      breadcrumbDirectiveDraft.set("");
      addItemOpen.set(false);
      addItemDraft.set("");
      addItemType.set("");
    });

    const openBreadcrumbDirective = action(({ prefix, ctx }: { prefix: string; ctx: string }) => {
      breadcrumbDirectivePrefix.set(prefix);
      breadcrumbDirectiveContext.set(ctx);
      breadcrumbDirectiveOpen.set(true);
      breadcrumbDirectiveDraft.set("");
      selectedItem.set("");
      itemDirectiveOpen.set(false);
    });

    const sendBreadcrumbDirective = action(() => {
      const text = breadcrumbDirectiveDraft.get().trim();
      if (!text) return;
      const prefix = breadcrumbDirectivePrefix.get();
      const ctx = breadcrumbDirectiveContext.get();
      const now = new Date().toISOString();
      userActions.set([...userActions.get(), { type: "directive", target: ctx, text: prefix + text, ts: now }]);
      breadcrumbDirectiveDraft.set("");
      breadcrumbDirectiveOpen.set(false);
      syncPending.set(true);
      syncTriggeredAt.set(new Date().toISOString());
      fetch("http://127.0.0.1:9876/sync", { method: "POST", mode: "cors" });
    });

    // D-106 inline edit actions STRIPPED — caused reactive loop / "Too many iterations"

    // Per-item actions
    const selectItem = action(({ key }: { key: string }) => {
      const current = selectedItem.get();
      selectedItem.set(current === key ? "" : key);
      itemDirectiveOpen.set(false);
      itemDirectiveDraft.set("");
      subProjectOpen.set(false);
      subProjectDraft.set("");
    });

    const markItemDone = action(({ key }: { key: string }) => {
      const [panel, idxStr] = [key.split(":")[0], key.split(":")[1]];
      const idx = parseInt(idxStr);
      const now = new Date().toISOString();
      let text = "";
      if (panel === "inbox") {
        const item = displayInbox[idx];
        if (item) text = item.text;
      } else if (panel === "waiting") {
        const item = displayWaiting[idx];
        if (item) text = item.entity;
      } else if (panel === "people") {
        const item = displayPeople[idx];
        if (item) text = item.name;
      } else if (panel === "projects") {
        const item = displayProjects[idx];
        if (item) text = item.name;
      } else if (panel === "actions") {
        const item = displayActions[idx];
        if (item) text = item.text;
      }
      if (text) {
        userActions.set([...userActions.get(), { type: "done", panel, text, ts: now }]);
      }
      selectedItem.set("");
    });

    const unmarkItemDone = action(({ key }: { key: string }) => {
      const [panel, idxStr] = [key.split(":")[0], key.split(":")[1]];
      const idx = parseInt(idxStr);
      const now = new Date().toISOString();
      let text = "";
      if (panel === "inbox") {
        const item = displayInbox[idx];
        if (item) text = item.text;
      }
      if (text) {
        userActions.set([...userActions.get(), { type: "undone", panel, text, ts: now }]);
      }
    });

    const deleteItem = action(({ key }: { key: string }) => {
      const [panel, idxStr] = [key.split(":")[0], key.split(":")[1]];
      const idx = parseInt(idxStr);
      const now = new Date().toISOString();
      let text = "";
      if (panel === "inbox") {
        const item = displayInbox[idx];
        if (item) text = item.text;
      } else if (panel === "waiting") {
        const item = displayWaiting[idx];
        if (item) text = item.entity;
      } else if (panel === "people") {
        const item = displayPeople[idx];
        if (item) text = item.name;
      } else if (panel === "projects") {
        const item = displayProjects[idx];
        if (item) text = item.name;
      } else if (panel === "actions") {
        const item = displayActions[idx];
        if (item) text = item.text;
      }
      if (text) {
        userActions.set([...userActions.get(), { type: "delete", panel, text, ts: now }]);
      }
      selectedItem.set("");
    });

    const makeProject = action(({ key }: { key: string }) => {
      const parts = key.split(":");
      const idx = parseInt(parts[1]);
      if (parts[0] !== "inbox") return;
      const item = displayInbox[idx];
      if (!item) return;
      const text = item.text;
      const now = new Date().toISOString();
      userActions.set([...userActions.get(),
        { type: "delete", panel: "inbox", text, ts: now },
        { type: "directive", target: "projects", text: "Add project: " + text, ts: now },
      ]);
      selectedItem.set("");
    });

    const makePerson = action(({ key }: { key: string }) => {
      const parts = key.split(":");
      const idx = parseInt(parts[1]);
      if (parts[0] !== "inbox") return;
      const item = displayInbox[idx];
      if (!item) return;
      const text = item.text;
      const now = new Date().toISOString();
      userActions.set([...userActions.get(),
        { type: "delete", panel: "inbox", text, ts: now },
        { type: "directive", target: "people", text: "Add person: " + text, ts: now },
      ]);
      selectedItem.set("");
    });

    const makeThing = action(({ key }: { key: string }) => {
      const parts = key.split(":");
      const idx = parseInt(parts[1]);
      if (parts[0] !== "inbox") return;
      const item = displayInbox[idx];
      if (!item) return;
      const text = item.text;
      const now = new Date().toISOString();
      userActions.set([...userActions.get(),
        { type: "delete", panel: "inbox", text, ts: now },
        { type: "directive", target: "things", text: "Add thing: " + text, ts: now },
      ]);
      selectedItem.set("");
    });

    const openItemDirective = action(() => {
      itemDirectiveOpen.set(true);
      subProjectOpen.set(false);
    });

    const sendItemDirective = action(() => {
      const selKey = selectedItem.get();
      if (!selKey) return;
      const text = itemDirectiveDraft.get().trim();
      if (!text) return;

      const [panel, idxStr] = [selKey.split(":")[0], selKey.split(":")[1]];
      const idx = parseInt(idxStr);

      // Build context prefix based on item from display computeds
      let prefix = "";
      let target = panel;
      if (panel === "inbox") {
        const item = displayInbox[idx];
        if (item) {
          // Detect NEEDS_HUMAN inbox items: "D-NNN needs input — ..."
          const nhMatch = item.text.match(/^(D-\d+) needs input/);
          if (nhMatch) {
            // Reply directly to the original directive
            prefix = "Re: " + nhMatch[1] + " — ";
            target = "system";
          } else {
            prefix = "Re: " + item.text + " — ";
          }
        }
      } else if (panel === "projects") {
        const item = displayProjects[idx];
        if (item) prefix = "Re: " + item.name + " — ";
      } else if (panel === "people") {
        const item = displayPeople[idx];
        if (item) prefix = "Re: " + item.name + " — ";
      } else if (panel === "waiting") {
        const item = displayWaiting[idx];
        if (item) prefix = "Re: " + item.entity + " — ";
      } else if (panel === "actions") {
        const item = displayActions[idx];
        if (item) prefix = "Re: " + item.text + " — ";
      } else if (panel === "things") {
        // key is "things:path/to/folder" — use path as prefix
        const path = selKey.substring("things:".length);
        prefix = "Re: Things/" + path + " — ";
      }

      const now = new Date().toISOString();
      userActions.set([...userActions.get(), { type: "directive", target, text: prefix + text, ts: now }]);

      itemDirectiveDraft.set("");
      itemDirectiveOpen.set(false);
      selectedItem.set("");
      // Auto-sync after sending directive so dispatch picks it up immediately
      syncPending.set(true);
      syncTriggeredAt.set(new Date().toISOString());
      fetch("http://127.0.0.1:9876/sync", { method: "POST", mode: "cors" });
    });

    const openSubProject = action(() => {
      subProjectOpen.set(true);
      subProjectDraft.set("");
      itemDirectiveOpen.set(false);
    });

    const sendSubProject = action(() => {
      const selKey = selectedItem.get();
      if (!selKey) return;
      const text = subProjectDraft.get().trim();
      if (!text) return;
      const idx = parseInt(selKey.split(":")[1]);
      const project = displayProjects[idx];
      if (!project) return;
      const now = new Date().toISOString();
      userActions.set([...userActions.get(), { type: "directive", target: "projects", text: "Add subproject to " + project.name + ": " + text, ts: now }]);
      subProjectDraft.set("");
      subProjectOpen.set(false);
      selectedItem.set("");
      syncPending.set(true);
      syncTriggeredAt.set(new Date().toISOString());
      fetch("http://127.0.0.1:9876/sync", { method: "POST", mode: "cors" });
    });

    const openAddItem = action(() => {
      addItemOpen.set(true);
      addItemDraft.set("");
      addItemType.set("");
      selectedItem.set("");
      itemDirectiveOpen.set(false);
    });

    const openAddSubItem = action(({ itemType }: { itemType: string }) => {
      addItemType.set(itemType);
      addItemOpen.set(true);
      addItemDraft.set("");
      selectedItem.set("");
      itemDirectiveOpen.set(false);
    });

    const sendAddItem = action(() => {
      const text = addItemDraft.get().trim();
      if (!text) return;
      const now = new Date().toISOString();
      const panel = expandedPanel.get();
      if (panel === "inbox") {
        userActions.set([...userActions.get(), { type: "add", panel: "inbox", text, ts: now }]);
      } else if (panel === "projects") {
        const crumbs = projectBreadcrumbs.get() || [];
        if (crumbs.length > 0) {
          // Subproject → needs directive (complex operation)
          const last = crumbs[crumbs.length - 1];
          const bar = last.indexOf("|");
          const parentName = bar >= 0 ? last.substring(bar + 1) : last;
          userActions.set([...userActions.get(), { type: "directive", target: "projects", text: "Add subproject to " + parentName + ": " + text, ts: now }]);
        } else {
          // Top-level project → direct add (handled by sync)
          userActions.set([...userActions.get(), { type: "add", panel: "projects", text, ts: now }]);
        }
        syncPending.set(true);
        syncTriggeredAt.set(now);
        fetch("http://127.0.0.1:9876/sync", { method: "POST", mode: "cors" });
      } else if (panel === "people") {
        const peopleCrumbs = peopleBreadcrumbs.get() || [];
        if (peopleCrumbs.length > 0) {
          const last = peopleCrumbs[peopleCrumbs.length - 1];
          const bar = last.indexOf("|");
          const personId = bar >= 0 ? last.substring(0, bar) : last;
          const personName = bar >= 0 ? last.substring(bar + 1) : last;
          const itype = addItemType.get();
          if (itype === "action") {
            userActions.set([...userActions.get(), { type: "directive", target: "people", text: "Add action linked to " + personId + " " + personName + ": " + text, ts: now }]);
          } else {
            userActions.set([...userActions.get(), { type: "directive", target: "people", text: "Add project linked to " + personId + " " + personName + ": " + text, ts: now }]);
          }
        } else {
          userActions.set([...userActions.get(), { type: "directive", target: "people", text: "Add person: " + text, ts: now }]);
        }
        addItemType.set("");
        syncPending.set(true);
        syncTriggeredAt.set(now);
        fetch("http://127.0.0.1:9876/sync", { method: "POST", mode: "cors" });
      } else if (panel === "waiting") {
        userActions.set([...userActions.get(), { type: "add", panel: "waiting", text, ts: now }]);
        syncPending.set(true);
        syncTriggeredAt.set(now);
        fetch("http://127.0.0.1:9876/sync", { method: "POST", mode: "cors" });
      }
      addItemDraft.set("");
      addItemOpen.set(false);
    });

    const answerQuestion = action(
      ({
        id,
        answer,
        author,
      }: {
        id: string;
        answer: string;
        author: string;
      }) => {
        const now = new Date().toISOString();
        userActions.set([...userActions.get(), { type: "answer", questionId: id, answer, author, ts: now }]);
        selectedId.set("");
        draftAnswer.set("");
      },
    );

    const addReply = action(
      ({
        id,
        text,
        author,
      }: {
        id: string;
        text: string;
        author: string;
      }) => {
        const now = new Date().toISOString();
        userActions.set([...userActions.get(), { type: "reply", questionId: id, text, author, ts: now }]);
        selectedId.set("");
        draftAnswer.set("");
      },
    );

    const dismissQuestion = action(({ id }: { id: string }) => {
      const now = new Date().toISOString();
      userActions.set([...userActions.get(), { type: "dismiss", questionId: id, ts: now }]);
      selectedId.set("");
      draftAnswer.set("");
    });

    const cancelDirective = action(({ id }: { id: string }) => {
      const now = new Date().toISOString();
      userActions.set([...userActions.get(), { type: "cancel", directiveId: id, ts: now }]);
    });

    const reopenQuestion = action(({ id }: { id: string }) => {
      selectedId.set(id);
      draftAnswer.set("");
    });

    const selectQuestion = action(({ id }: { id: string }) => {
      selectedId.set(id);
      draftAnswer.set("");
    });

    const submitDraft = action(() => {
      const id = selectedId.get();
      const answer = draftAnswer.get();
      if (!id || !answer.trim()) return;

      const q = displayQuestions.find((qq: Question) => qq.id === id);
      if (q && q.status === "answered") {
        addReply.send({
          id,
          text: answer.trim(),
          author: "human-lead",
        });
      } else {
        answerQuestion.send({
          id,
          answer: answer.trim(),
          author: "human-lead",
        });
      }
    });

    return {
      [NAME]: computed(
        () => `GTDash (${pendingCount} pending)`,
      ),
      [UI]: (
        <div
          style={{
            fontFamily: font,
            background: color.secondaryBg,
            minHeight: "100vh",
            color: color.label,
          }}
        >
          {/* ── Dynamic selection highlight via CSS ── */}
          {computed(() => {
            const sel = selectedItem.get();
            if (!sel) return null;
            const iid = cssId("si_", sel);
            const tid = cssId("tb_", sel);
            return (
              <style>
                {`#${iid} { background: rgba(0, 122, 255, 0.06) !important; border-radius: 8px !important; padding: 8px !important; } #${tid} { display: flex !important; }`}
              </style>
            );
          })}
          {/* ── Header ── */}
          <div
            style={{
              padding: "20px 24px 0",
              background: color.background,
              borderBottom: `0.5px solid ${color.separator}`,
            }}
          >
            {/* Title row */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: "16px",
              }}
            >
              <span
                style={{
                  fontSize: "28px",
                  fontWeight: "700",
                  letterSpacing: "-0.5px",
                }}
              >
                GTDash
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div
                  style={computed(() => ({
                    padding: "5px 14px",
                    borderRadius: "100px",
                    fontSize: "13px",
                    fontWeight: "600",
                    background: dispatchOpen.get()
                      ? "#af52de"
                      : "rgba(175, 82, 222, 0.12)",
                    color: dispatchOpen.get() ? "#fff" : "#af52de",
                    cursor: "pointer",
                    transition: "all 0.2s ease",
                  }))}
                  onClick={toggleDispatch}
                >
                  Wish
                </div>
                <a
                  href={computed(() => {
                    const s = status.get();
                    const space = s.spaceName || "GTDFeb26.2";
                    const calId = s.calendarPieceId || "";
                    return calId ? `/${space}/${calId}` : "#";
                  })}
                  target="_blank"
                  style={{
                    padding: "5px 14px",
                    borderRadius: "100px",
                    fontSize: "13px",
                    fontWeight: "600",
                    background: "rgba(0, 122, 255, 0.12)",
                    color: "#007AFF",
                    cursor: "pointer",
                    textDecoration: "none",
                    transition: "all 0.2s ease",
                  }}
                >
                  Cal
                </a>
                <span
                  style={computed(() => {
                    const s = status.get();
                    const health = s.syncHealth;
                    const failures = health?.consecutiveFailures || 0;
                    const minsStale = health?.minutesSinceSuccess || 0;
                    let col = color.tertiaryLabel;
                    if (minsStale > 15 || failures >= 3) col = "#FF3B30";
                    else if (minsStale > 5) col = "#FF9500";
                    return { fontSize: "12px", color: col, fontWeight: minsStale > 15 ? "600" : "400" };
                  })}
                >
                  {computed(() => {
                    const s = status.get();
                    const raw = s.lastSync;
                    if (!raw) return "";
                    const health = s.syncHealth;
                    const failures = health?.consecutiveFailures || 0;
                    const minsStale = health?.minutesSinceSuccess || 0;
                    if (minsStale > 15 || failures >= 3) {
                      return `\u26A0 Last synced ${minsStale}m ago`;
                    }
                    if (minsStale > 5) {
                      return `Synced ${minsStale}m ago`;
                    }
                    const d = new Date(raw);
                    const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
                    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                    const dayName = days[d.getDay()];
                    const month = months[d.getMonth()];
                    const date = d.getDate();
                    let hours = d.getHours();
                    const minutes = d.getMinutes();
                    const ampm = hours >= 12 ? "pm" : "am";
                    hours = hours % 12 || 12;
                    const mins = minutes < 10 ? `0${minutes}` : `${minutes}`;
                    return `Synced ${dayName} ${month} ${date} @ ${hours}:${mins}${ampm}`;
                  })}
                </span>
                <div
                  style={computed(() => {
                    const pending = syncPending.get();
                    const triggered = syncTriggeredAt.get();
                    const last = status.get().lastSync;
                    const isSyncing = pending && (!last || triggered > last);
                    return {
                      fontSize: "18px",
                      cursor: "pointer",
                      opacity: isSyncing ? 1 : 0.5,
                      lineHeight: "1",
                    };
                  })}
                  onClick={syncNow}
                >
                  {"ᯤ"}
                </div>
              </div>
            </div>

            {/* Command input row */}
            {ifElse(
              computed(() => dispatchOpen.get()),
              <div style={{ marginBottom: "12px" }}>
                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    alignItems: "center",
                  }}
                >
                  <ct-textarea
                    $value={dispatchDraft}
                    placeholder="Make a wish..."
                    rows={1}
                    style="flex: 1; border-radius: 10px; font-size: 14px;"
                  />
                  <div
                    style={directiveSendBtnStyle}
                    onClick={sendDispatch}
                  >
                    Send
                  </div>
                </div>
                {computed(() => {
                    const all = directives.get() || [];
                    const active = all.filter((d: Directive) => d && (d.status === "pending" || d.status === "assigned"));
                    // Build optimistic entries from userActions not yet synced
                    const ua = (userActions.get() || []).filter(Boolean);
                    const pendingUA = ua.filter((a: UserAction) => a && a.type === "directive");
                    const cancelledIds = new Set(ua.filter((a: UserAction) => a && a.type === "cancel" && a.directiveId).map((a: UserAction) => a.directiveId));
                    const syncedTexts = new Set(all.filter((d: Directive) => d && d.text).map((d: Directive) => d.text));
                    const optimistic: Directive[] = pendingUA
                      .filter((a: UserAction) => !syncedTexts.has(a.text || ""))
                      .map((a: UserAction) => ({ id: "...", target: a.target || "system", text: a.text || "", createdAt: a.ts || "", status: "sending", response: "", assignedTo: "", noteUrl: "" }));
                    const combined = [...optimistic, ...active].filter((d: Directive) => !cancelledIds.has(d.id));
                    if (combined.length === 0) return (
                      <div style={{ marginTop: "10px", fontSize: "13px", color: color.tertiaryLabel, padding: "8px 0" }}>
                        No active wishes.
                      </div>
                    );
                    return (
                      <div style={{ marginTop: "10px" }}>
                        <div style={{ fontSize: "11px", fontWeight: "600", color: color.secondaryLabel, textTransform: "uppercase" as const, letterSpacing: "0.5px", marginBottom: "6px" }}>
                          Active Wishes
                        </div>
                        {combined.map((d: Directive) => (
                          <div style={{ fontSize: "13px", padding: "6px 0", borderBottom: `0.5px solid ${color.separator}`, display: "flex", gap: "8px", alignItems: "center" }}>
                            <span style={{ fontWeight: "600", color: d.status === "sending" ? color.tertiaryLabel : color.indigo, flexShrink: "0" }}>{d.id}</span>
                            <span style={{ color: color.secondaryLabel, flexShrink: "0", fontSize: "11px" }}>{d.target}</span>
                            <span style={{ color: color.label, flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{(d.text || "").length > 80 ? d.text.slice(0, 80) + "\u2026" : d.text || ""}</span>
                            <span style={{
                              color: d.status === "sending" ? color.tertiaryLabel : d.status === "pending" ? color.orange : color.green,
                              fontSize: "11px",
                              fontWeight: "500",
                              flexShrink: "0",
                              fontStyle: d.status === "sending" ? "italic" : "normal",
                            }}>{d.status === "assigned" ? "in progress" : d.status === "sending" ? "sending\u2026" : d.status}</span>
                            {d.id !== "..." ? (
                              <div
                                style={{ color: color.tertiaryLabel, fontSize: "14px", cursor: "pointer", flexShrink: "0", padding: "0 2px", lineHeight: "1" }}
                                onClick={() => cancelDirective.send({ id: d.id })}
                              >
                                {"\u00d7"}
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                {/* Recent Wishes — only visible in Command view */}
                {computed(() => {
                  const dirs: Directive[] = [...(directives.get() || [])].filter((d: Directive) => d && d.id);
                  const done = dirs.filter((d: Directive) => d.status === "done");
                  if (done.length === 0) return null;

                  // Show most recent 10
                  const recent = done.slice(0, 10);
                  return (
                    <div style={{ marginTop: "12px" }}>
                      <div style={{ fontSize: "11px", fontWeight: "600", color: color.secondaryLabel, textTransform: "uppercase" as const, letterSpacing: "0.5px", marginBottom: "8px" }}>
                        Recent Wishes
                      </div>
                      {recent.map((d: Directive) => (
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 0", borderBottom: "0.5px solid " + color.separator }}>
                          <span style={{ fontSize: "11px", color: color.tertiaryLabel, fontWeight: "500", minWidth: "40px", flexShrink: "0" }}>{d.id}</span>
                          <span style={{ fontSize: "13px", color: color.label, flex: "1", overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const }}>{d.text}</span>
                          {d.assignedTo ? <span style={{ fontSize: "10px", color: color.secondaryLabel, padding: "1px 6px", borderRadius: "100px", background: color.fillPrimary }}>{d.assignedTo}</span> : null}
                          {d.noteUrl ? (() => {
                            let nurl = d.noteUrl;
                            const currentSpaceDir = status.get().spaceName || "GTDFeb26.2";
                            if (nurl.match(/^\/[^\/]+\/baedrei/)) nurl = "/" + currentSpaceDir + nurl.substring(nurl.indexOf("/", 1));
                            return (
                              <a href={nurl} target="_blank" style={{ textDecoration: "none", fontSize: "16px", flexShrink: "0", cursor: "pointer" }}>
                                {"📎"}
                              </a>
                            );
                          })() : null}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>,
              null,
            )}

            {/* Stat widgets + weather — tappable */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr 1fr",
                gap: "10px",
                marginBottom: "16px",
              }}
            >
              {/* Inbox card */}
              <div
                style={cardStyleInbox}
                onClick={() => togglePanel.send({ panel: "inbox" })}
              >
                <div style={{ display: "flex", alignItems: "center" }}>
                  <div
                    style={{
                      fontSize: "22px",
                      fontWeight: "600",
                      letterSpacing: "-0.5px",
                      lineHeight: "1.1",
                    }}
                  >
                    {computed(() => displayInbox.length)}
                  </div>
                  <span style={chevronStyleInbox}>▶</span>
                </div>
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: "500",
                    color: color.secondaryLabel,
                    marginTop: "2px",
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.5px",
                  }}
                >
                  Inbox
                </div>
              </div>
              {/* Projects card */}
              <div
                style={cardStyleProjects}
                onClick={() => togglePanel.send({ panel: "projects" })}
              >
                <div style={{ display: "flex", alignItems: "center" }}>
                  <div
                    style={{
                      fontSize: "22px",
                      fontWeight: "600",
                      letterSpacing: "-0.5px",
                      lineHeight: "1.1",
                    }}
                  >
                    {computed(() => {
                      if (showCompleted.get()) return displayProjects.length;
                      return displayProjects.filter((p: Project) => p.status !== "Done" && p.status !== "Archived").length;
                    })}
                  </div>
                  <span style={chevronStyleProjects}>▶</span>

                </div>
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: "500",
                    color: color.secondaryLabel,
                    marginTop: "2px",
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.5px",
                  }}
                >
                  Projects
                </div>
              </div>
              {/* People card */}
              <div
                style={cardStylePeople}
                onClick={() => togglePanel.send({ panel: "people" })}
              >
                <div style={{ display: "flex", alignItems: "center" }}>
                  <div
                    style={{
                      fontSize: "22px",
                      fontWeight: "600",
                      letterSpacing: "-0.5px",
                      lineHeight: "1.1",
                    }}
                  >
                    {computed(() => displayPeople.length)}
                  </div>
                  <span style={chevronStylePeople}>▶</span>
                </div>
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: "500",
                    color: color.secondaryLabel,
                    marginTop: "2px",
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.5px",
                  }}
                >
                  People
                </div>
              </div>
              {/* Things card */}
              <div
                style={cardStyleThings}
                onClick={() => togglePanel.send({ panel: "things" })}
              >
                <div style={{ display: "flex", alignItems: "center" }}>
                  <div
                    style={{
                      fontSize: "22px",
                      fontWeight: "600",
                      letterSpacing: "-0.5px",
                      lineHeight: "1.1",
                    }}
                  >
                    {computed(() => {
                      const things: ThingItem[] = (items.get()?.things || []).filter(Boolean) as ThingItem[];
                      return things.filter((t: ThingItem) => t.type === "folder").length;
                    })}
                  </div>
                  <span style={chevronStyleThings}>▶</span>
                </div>
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: "500",
                    color: color.secondaryLabel,
                    marginTop: "2px",
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.5px",
                  }}
                >
                  Things
                </div>
              </div>
              {/* Weather removed to reduce memory footprint */}
            </div>
          </div>

          {/* ── Active Panel (only one renders at a time) ── */}
          <div style={{ padding: "12px 16px 0" }}>
            {computed(() => {
              const panel = expandedPanel.get();
              if (panel === "inbox") return (
              <div style={panelCardStyle}>
                <div style={groupHeaderStyle}>Inbox Items</div>
                {computed(() => {
                  const inboxItems = displayInbox;
                  if (inboxItems.length === 0) {
                    return (
                      <div
                        style={{
                          fontSize: "13px",
                          color: color.tertiaryLabel,
                          padding: "12px 0",
                        }}
                      >
                        Inbox is empty
                      </div>
                    );
                  }

                  // Build inbox item -> noteUrl lookup from directives
                  // Rewrite relative piece URLs to use the current space
                  const currentSpaceInbox = status.get().spaceName || "GTDFeb26.2";
                  const inboxNotes: Record<string, string> = {};
                  const allDirsInbox: Directive[] = [...(directives.get() || [])].filter((d: Directive) => d && d.id && d.noteUrl && d.target === "inbox");
                  for (const d of allDirsInbox) {
                    const m = d.text.match(/^Re:\s*(.+?)\s*—/);
                    if (m && d.noteUrl) {
                      let url = d.noteUrl;
                      if (url.match(/^\/[^\/]+\/baedrei/)) url = "/" + currentSpaceInbox + url.substring(url.indexOf("/", 1));
                      inboxNotes[m[1]] = url;
                    }
                  }

                  return inboxItems.map((item: InboxItem, idx: number) => {
                    // Match inbox item text against noteUrl lookup (match before first "—" if present)
                    const itemKey = item.text.indexOf("—") >= 0 ? item.text.substring(0, item.text.indexOf("—")).trim() : item.text.trim();
                    const noteLink = inboxNotes[itemKey] || "";
                    const ni = noticeInfo(item.text);
                    const ik = "inbox:" + idx;
                    return (
                    <div>
                      <div
                        id={ni.isNotice ? undefined : cssId("si_", ik)}
                        style={ni.isNotice
                          ? { ...itemRowStyle, cursor: "default", opacity: item.done ? 0.5 : 1 }
                          : { ...itemRowStyle, cursor: "pointer" }}
                        onClick={ni.isNotice ? undefined : (() => selectItem.send({ key: ik }))}
                      >
                        {ni.isNotice ? (
                          <span style={{ fontSize: "16px", marginRight: "8px", flexShrink: "0", verticalAlign: "middle" }}>{ni.emoji}</span>
                        ) : (
                          <span
                            style={{
                              display: "inline-block",
                              width: "14px",
                              height: "14px",
                              borderRadius: "50%",
                              border: item.done ? `2px solid ${color.green}` : `2px solid ${color.tertiaryLabel}`,
                              background: item.done ? color.green : "transparent",
                              marginRight: "10px",
                              verticalAlign: "middle",
                              flexShrink: "0",
                            }}
                          />
                        )}
                        <span
                          style={{
                            verticalAlign: "middle",
                            color: item.done ? color.tertiaryLabel : color.label,
                            flex: "1",
                            fontSize: "13px",
                            textDecoration: item.done ? "line-through" : "none",
                          }}
                        >
                          {item.text}
                        </span>
                        {ni.isNotice && !item.done ? (
                          <div style={actionBtnDismiss} onClick={() => deleteItem.send({ key: ik })}>Dismiss</div>
                        ) : null}
                        {noteLink ? (
                          <a href={noteLink} target="_blank" style={{ textDecoration: "none", fontSize: "16px", flexShrink: "0", cursor: "pointer", marginLeft: "4px" }}>
                            {"📎"}
                          </a>
                        ) : null}
                      </div>
                      {!ni.isNotice && (
                        <div id={cssId("tb_", ik)} style={{ display: "none", gap: "8px", padding: "6px 0 8px", flexWrap: "wrap" as const }}>
                          <div style={actionBtnDone} onClick={() => markItemDone.send({ key: ik })}>✓ Done</div>
                          <div style={actionBtnDelete} onClick={() => deleteItem.send({ key: ik })}>✕ Delete</div>
                          <div style={actionBtnDirective} onClick={openItemDirective}>→ Wish</div>
                          <div style={actionBtnProject} onClick={() => makeProject.send({ key: ik })}>→ Project</div>
                          <div style={actionBtnPerson} onClick={() => makePerson.send({ key: ik })}>→ Person</div>
                          <div style={actionBtnThing} onClick={() => makeThing.send({ key: ik })}>→ Thing</div>
                        </div>
                      )}
                    </div>
                  );
                  });
                })}
                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    marginTop: "12px",
                    alignItems: "center",
                  }}
                >
                  <ct-textarea
                    $value={inboxDraft}
                    placeholder="Add to inbox..."
                    rows={1}
                    style="flex: 1; border-radius: 10px; font-size: 14px;"
                  />
                  <div
                    style={{
                      padding: "8px 16px",
                      borderRadius: "100px",
                      fontSize: "13px",
                      fontWeight: "600",
                      background: color.blue,
                      color: "#fff",
                      cursor: "pointer",
                      flexShrink: "0",
                    }}
                    onClick={addInboxItem}
                  >
                    Add
                  </div>
                </div>
              </div>
              );
              if (panel === "projects") return (
              <div style={panelCardStyle}>
                {/* Breadcrumb bar */}
                {computed(() => {
                  const crumbStrs = projectBreadcrumbs.get() || [];
                  // Validate breadcrumbs against current data
                  const projectItems2: Project[] = [...displayProjects].filter(Boolean);
                  const knownIds2 = new Set<string>();
                  for (const p of projectItems2) {
                    knownIds2.add(p.id);
                    if (p.parentId) knownIds2.add(p.parentId);
                  }
                  let crumbs = crumbStrs.map((s: string) => {
                    const bar = s.indexOf("|");
                    return { id: bar >= 0 ? s.substring(0, bar) : s, name: bar >= 0 ? s.substring(bar + 1) : s };
                  });
                  if (crumbs.length > 0 && crumbs.some((c: { id: string; name: string }) => !knownIds2.has(c.id))) {
                    crumbs = [];
                  }
                  if (crumbs.length === 0) {
                    return (
                      <div style={{ ...groupHeaderStyle, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span>Projects</span>
                        <span
                          style={{
                            fontSize: "11px",
                            fontWeight: "500",
                            color: showCompleted.get() ? color.blue : color.tertiaryLabel,
                            cursor: "pointer",
                          }}
                          onClick={toggleShowCompleted}
                        >
                          {showCompleted.get() ? "Hide Done" : "Show Done"}
                        </span>
                      </div>
                    );
                  }
                  const currentCrumb = crumbs[crumbs.length - 1];
                  const dirOpen = breadcrumbDirectiveOpen.get();
                  return (
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "0", flexWrap: "wrap" as const, padding: "4px 0 8px" }}>
                        <span
                          style={{ fontSize: "13px", fontWeight: "500", color: color.blue, cursor: "pointer" }}
                          onClick={() => navigateBreadcrumb.send({ depth: -1 })}
                        >
                          Projects
                        </span>
                        {crumbs.map((c: {id: string, name: string}, i: number) => (
                          <span style={{ display: "inline-flex", alignItems: "center" }}>
                            <span style={{ fontSize: "12px", color: color.tertiaryLabel, margin: "0 6px" }}>/</span>
                            {i < crumbs.length - 1 ? (
                              <span
                                style={{ fontSize: "13px", fontWeight: "500", color: color.blue, cursor: "pointer" }}
                                onClick={() => navigateBreadcrumb.send({ depth: i })}
                              >
                                {c.name}
                              </span>
                            ) : (
                              <span style={{ fontSize: "13px", fontWeight: "600", color: color.label }}>
                                {c.name}
                              </span>
                            )}
                          </span>
                        ))}
                        <div
                          style={{ marginLeft: "auto", ...actionBtnDirective, fontSize: "11px", padding: "3px 10px" }}
                          onClick={() => openBreadcrumbDirective.send({ prefix: "Re: " + currentCrumb.name + " — ", ctx: "projects" })}
                        >
                          → Wish
                        </div>
                      </div>
                      {dirOpen ? (
                        <div style={{ ...directiveInputRowStyle, marginBottom: "8px" }}>
                          <ct-textarea
                            $value={breadcrumbDirectiveDraft}
                            placeholder={"Wish about " + currentCrumb.name + "..."}
                            rows={1}
                            style="flex: 1; border-radius: 10px; font-size: 14px;"
                          />
                          <div style={directiveSendBtnStyle} onClick={sendBreadcrumbDirective}>
                            Send
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {computed(() => {
                  const projectItems: Project[] = [...displayProjects].filter(Boolean);
                  const peopleItems: Person[] = (items.get()?.people || []).filter(Boolean) as Person[];
                  const crumbStrs2 = projectBreadcrumbs.get() || [];
                  const crumbs = crumbStrs2.map((s: string) => {
                    const bar = s.indexOf("|");
                    return { id: bar >= 0 ? s.substring(0, bar) : s, name: bar >= 0 ? s.substring(bar + 1) : s };
                  });

                  // Build project name -> noteUrl lookup from directives
                  // Rewrite relative piece URLs to use the current space
                  const currentSpace = status.get().spaceName || "GTDFeb26.2";
                  const projectNotes: Record<string, string> = {};
                  const allDirs: Directive[] = [...(directives.get() || [])].filter((d: Directive) => d && d.id && d.noteUrl);
                  for (const d of allDirs) {
                    const m = d.text.match(/^Re:\s*(.+?)\s*—/);
                    if (m && d.noteUrl) {
                      let url = d.noteUrl;
                      if (url.match(/^\/[^\/]+\/baedrei/)) url = "/" + currentSpace + url.substring(url.indexOf("/", 1));
                      projectNotes[m[1]] = url;
                    }
                  }

                  if (projectItems.length === 0) {
                    return (
                      <div style={{ fontSize: "13px", color: color.tertiaryLabel, padding: "12px 0" }}>
                        No projects
                      </div>
                    );
                  }

                  const hideCompleted = !showCompleted.get();
                  const isCompleted = (s: string) => s === "Done" || s === "Archived";

                  // Build children-of map (use all projects for hierarchy)
                  const childrenOf: Record<string, Project[]> = {};
                  // Also build a filtered version for counting visible children
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

                  // Build set of project IDs that have linked actions (for drill-in eligibility)
                  const allActionsArr: NextAction[] = displayActions;
                  const projectsWithActions = new Set<string>();
                  for (const a of allActionsArr) {
                    if (a.projectId) projectsWithActions.add(a.projectId);
                  }

                  // Build set of project names that have completed directive responses
                  const allDirectives = [...(directives.get() || [])] as Directive[];
                  const projectsWithResponses = new Set<string>();
                  for (const d of allDirectives) {
                    if (!d || d.status !== "done" || !d.response) continue;
                    const dm = d.text.match(/^Re:\s*(.+?)\s*\u2014/);
                    if (dm) projectsWithResponses.add(dm[1]);
                  }

                  // Determine which items to show at current breadcrumb depth
                  let visibleItems: { type: string, id: string, name: string, project: Project | null, action: NextAction | null, idx: number, hasChildren: boolean }[] = [];

                  if (crumbs.length === 0) {
                    // Root level: show people who own projects + top-level projects
                    for (const parentId of Object.keys(visibleChildrenOf)) {
                      if (parentId.startsWith("PPL:")) {
                        const person = peopleItems.find((pp: Person) => pp.id === parentId);
                        const name = person ? person.name : parentId.split(":")[1];
                        visibleItems.push({ type: "person", id: parentId, name, project: null, action: null, idx: -1, hasChildren: true });
                      }
                    }
                    for (const p of projectItems) {
                      if (!p.parentId) {
                        if (hideCompleted && isCompleted(p.status)) continue;
                        const idx = projectItems.indexOf(p);
                        const hasKids = (visibleChildrenOf[p.id] || []).length > 0 || projectsWithActions.has(p.id) || projectsWithResponses.has(p.name);
                        visibleItems.push({ type: "project", id: p.id, name: p.name, project: p, action: null, idx, hasChildren: hasKids });
                      }
                    }
                  } else {
                    // Drilled into a node — show its children (sub-projects + related actions + responses)
                    const currentId = crumbs[crumbs.length - 1].id;
                    const currentProject = projectItems.find((p: Project) => p.id === currentId);
                    const children = childrenOf[currentId] || [];
                    for (const child of children) {
                      if (hideCompleted && isCompleted(child.status)) continue;
                      const idx = projectItems.indexOf(child);
                      const hasKids = (visibleChildrenOf[child.id] || []).length > 0 || projectsWithActions.has(child.id) || projectsWithResponses.has(child.name);
                      visibleItems.push({ type: "project", id: child.id, name: child.name, project: child, action: null, idx, hasChildren: hasKids });
                    }
                    // Related next actions for this project
                    const allActionsForProject: NextAction[] = displayActions;
                    const projectActions = allActionsForProject.filter((a: NextAction) => a.projectId === currentId);
                    for (let ai = 0; ai < projectActions.length; ai++) {
                      const pa = projectActions[ai];
                      const origIdx = allActionsForProject.indexOf(pa);
                      visibleItems.push({ type: "action", id: "action-" + origIdx, name: pa.text, project: null, action: pa, idx: origIdx, hasChildren: false });
                    }
                    // Completed directive responses as sub-items
                    if (currentProject) {
                      for (const d of allDirectives) {
                        if (!d || d.status !== "done" || !d.response) continue;
                        const dm = d.text.match(/^Re:\s*(.+?)\s*\u2014/);
                        if (dm && dm[1] === currentProject.name) {
                          visibleItems.push({ type: "response", id: d.id, name: d.text, project: null, action: null, idx: -1, hasChildren: false });
                        }
                      }
                    }
                  }

                  if (visibleItems.length === 0 && crumbs.length > 0) {
                    return (
                      <div style={{ fontSize: "13px", color: color.tertiaryLabel, padding: "12px 0" }}>
                        No child items
                      </div>
                    );
                  }

                  return visibleItems.map((item: { type: string, id: string, name: string, project: Project | null, action: NextAction | null, idx: number, hasChildren: boolean }) => {
                    if (item.type === "action") {
                      const a = item.action!;
                      return (
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
                          {a.context ? (
                            <span style={{ fontSize: "10px", color: color.blue, background: "rgba(0,122,255,0.08)", padding: "1px 6px", borderRadius: "100px", flexShrink: "0", fontWeight: "500" }}>
                              {a.context}
                            </span>
                          ) : null}
                          <span style={{ fontSize: "13px", color: color.secondaryLabel, flex: "1" }}>{a.text}</span>
                        </div>
                      );
                    }
                    // Directive response row
                    if (item.type === "response") {
                      const dir = allDirectives.find((dd: Directive) => dd.id === item.id);
                      if (!dir) return <div />;
                      const qMatch = dir.text.match(/^Re:\s*.+?\s*\u2014\s*(.+)$/);
                      const question = qMatch ? qMatch[1] : dir.text;
                      const dateStr = dir.createdAt
                        ? new Date(dir.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                        : "";
                      let noteLink = dir.noteUrl || "";
                      if (noteLink && noteLink.match(/^\/[^\/]+\/baedrei/)) noteLink = "/" + currentSpace + noteLink.substring(noteLink.indexOf("/", 1));
                      return (
                        <div style={{ ...itemRowStyle, padding: "10px 0" }}>
                          <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
                            <span style={{
                              padding: "2px 6px", borderRadius: "4px",
                              fontSize: "10px", fontWeight: "600",
                              background: "rgba(88, 86, 214, 0.12)",
                              color: color.indigo, flexShrink: "0", marginTop: "2px",
                            }}>{dir.id}</span>
                            <div style={{ flex: "1" }}>
                              <div style={{ fontSize: "13px", fontWeight: "500", color: color.label }}>
                                {question}
                              </div>
                              <div style={{
                                fontSize: "12px", color: color.secondaryLabel,
                                marginTop: "4px", lineHeight: "1.5",
                                whiteSpace: "pre-wrap" as const,
                              }}>
                                {dir.response}
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "6px" }}>
                                {dateStr ? (
                                  <span style={{ fontSize: "11px", color: color.tertiaryLabel }}>{dateStr}</span>
                                ) : null}
                                {noteLink ? (
                                  <a href={noteLink} target="_blank" style={{
                                    fontSize: "11px", color: color.blue, textDecoration: "none",
                                  }}>{"📎 View note"}</a>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    }

                    if (item.type === "person") {
                      // Person row — click drills in
                      return (
                        <div
                          style={{
                            ...itemRowStyle,
                            display: "flex",
                            alignItems: "center",
                            gap: "10px",
                            cursor: "pointer",
                          }}
                          onClick={() => drillIntoProject.send({ id: item.id, name: item.name })}
                        >
                          <span style={{ fontSize: "13px", fontWeight: "600", color: color.purple, flex: "1" }}>
                            {item.name}
                          </span>
                          <span style={{ fontSize: "11px", color: color.tertiaryLabel }}>
                            {(visibleChildrenOf[item.id] || []).length + " items"}
                          </span>
                          <span style={{ fontSize: "14px", color: color.tertiaryLabel, flexShrink: "0" }}>{">"}</span>
                        </div>
                      );
                    }

                    // Project row
                    const p = item.project!;
                    const idx = item.idx;
                    return (
                      <div>
                        <div
                          id={cssId("si_", "projects:" + idx)}
                          style={{ ...itemRowStyle, display: "flex", alignItems: "center", gap: "0px", cursor: "pointer" }}
                        >
                          {/* Item content — click to drill in if has children, else select to show buttons */}
                          <div
                            style={{ display: "flex", alignItems: "center", gap: "10px", flex: "1", cursor: "pointer" }}
                            onClick={() => item.hasChildren ? drillIntoProject.send({ id: item.id, name: p.name }) : selectItem.send({ key: "projects:" + idx })}
                          >
                            <span style={{ fontSize: "12px", color: color.tertiaryLabel, fontWeight: "500", minWidth: "32px", flexShrink: "0" }}>
                              {p.id}
                            </span>
                            <span style={{ flex: "1" }}>{p.name}</span>
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
                            <a href={projectNotes[p.name]} target="_blank" style={{ textDecoration: "none", fontSize: "16px", flexShrink: "0", cursor: "pointer", marginLeft: "4px" }}>
                              {"📎"}
                            </a>
                          ) : null}
                          {/* Drill-in chevron — click to navigate into project */}
                          {item.hasChildren ? (
                            <span style={{ fontSize: "14px", color: color.tertiaryLabel, paddingLeft: "8px", flexShrink: "0", cursor: "pointer" }} onClick={() => drillIntoProject.send({ id: item.id, name: p.name })}>{">"}</span>
                          ) : null}
                        </div>
                        <div id={cssId("tb_", "projects:" + idx)} style={{ display: "none", gap: "8px", padding: "6px 0 8px", flexWrap: "wrap" as const }}>
                          <div style={actionBtnDone} onClick={() => markItemDone.send({ key: "projects:" + idx })}>✓ Done</div>
                          <div style={actionBtnDelete} onClick={() => deleteItem.send({ key: "projects:" + idx })}>✕ Delete</div>
                          <div style={actionBtnDirective} onClick={openItemDirective}>→ Wish</div>
                        </div>
                      </div>
                    );
                  });
                })}
                {/* Add project / subproject */}
                {computed(() => {
                  const isOpen = addItemOpen.get();
                  const crumbs = projectBreadcrumbs.get() || [];
                  const label = crumbs.length > 0 ? "New Subproject" : "New Project";
                  const placeholder = crumbs.length > 0 ? "New subproject..." : "New project...";
                  if (!isOpen) return (
                    <div style={{ marginTop: "10px", display: "inline-flex", alignItems: "center", gap: "5px", cursor: "pointer", color: color.blue, fontSize: "13px", fontWeight: "500", padding: "4px 0" }} onClick={openAddItem}>
                      <span style={{ fontSize: "17px", fontWeight: "300", lineHeight: "1" }}>+</span>
                      <span>{label}</span>
                    </div>
                  );
                  return (
                    <div style={{ display: "flex", gap: "8px", marginTop: "10px", alignItems: "center" }}>
                      <ct-textarea $value={addItemDraft} placeholder={placeholder} rows={1} style="flex: 1; border-radius: 10px; font-size: 14px;" />
                      <div style={{ padding: "7px 16px", borderRadius: "100px", fontSize: "13px", fontWeight: "600", background: color.blue, color: "#fff", cursor: "pointer", flexShrink: "0" }} onClick={sendAddItem}>Add</div>
                      <div style={{ padding: "7px 10px", borderRadius: "100px", fontSize: "13px", color: color.secondaryLabel, cursor: "pointer", flexShrink: "0" }} onClick={() => { addItemOpen.set(false); addItemDraft.set(""); }}>Cancel</div>
                    </div>
                  );
                })}
              </div>
              );
              if (panel === "people") return (
              <div style={panelCardStyle}>
                {/* Breadcrumb header */}
                {computed(() => {
                  const crumbStrs = peopleBreadcrumbs.get() || [];
                  if (crumbStrs.length === 0) {
                    return (
                      <div style={{ ...groupHeaderStyle, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span>People</span>
                        <span
                          style={{
                            fontSize: "11px",
                            fontWeight: "500",
                            color: showCompleted.get() ? color.blue : color.tertiaryLabel,
                            cursor: "pointer",
                          }}
                          onClick={toggleShowCompleted}
                        >
                          {showCompleted.get() ? "Hide Done" : "Show Done"}
                        </span>
                      </div>
                    );
                  }
                  const crumbs = crumbStrs.map((s: string) => {
                    const bar = s.indexOf("|");
                    return { id: bar >= 0 ? s.substring(0, bar) : s, name: bar >= 0 ? s.substring(bar + 1) : s };
                  });
                  const currentCrumb = crumbs[crumbs.length - 1];
                  const dirOpen = breadcrumbDirectiveOpen.get();
                  return (
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "0", flexWrap: "wrap" as const, padding: "4px 0 8px" }}>
                        <span
                          style={{ fontSize: "13px", fontWeight: "500", color: color.blue, cursor: "pointer" }}
                          onClick={() => navigatePeopleBreadcrumb.send({ depth: -1 })}
                        >
                          People
                        </span>
                        {crumbs.map((c: { id: string, name: string }, i: number) => (
                          <span style={{ display: "inline-flex", alignItems: "center" }}>
                            <span style={{ fontSize: "12px", color: color.tertiaryLabel, margin: "0 6px" }}>/</span>
                            {i < crumbs.length - 1 ? (
                              <span
                                style={{ fontSize: "13px", fontWeight: "500", color: color.blue, cursor: "pointer" }}
                                onClick={() => navigatePeopleBreadcrumb.send({ depth: i })}
                              >
                                {c.name}
                              </span>
                            ) : (
                              <span style={{ fontSize: "13px", fontWeight: "600", color: color.label }}>
                                {c.name}
                              </span>
                            )}
                          </span>
                        ))}
                        <div
                          style={{ marginLeft: "auto", ...actionBtnDirective, fontSize: "11px", padding: "3px 10px" }}
                          onClick={() => openBreadcrumbDirective.send({ prefix: "Re: " + currentCrumb.name + " — ", ctx: "people" })}
                        >
                          → Wish
                        </div>
                      </div>
                      {dirOpen ? (
                        <div style={{ ...directiveInputRowStyle, marginBottom: "8px" }}>
                          <ct-textarea
                            $value={breadcrumbDirectiveDraft}
                            placeholder={"Wish about " + currentCrumb.name + "..."}
                            rows={1}
                            style="flex: 1; border-radius: 10px; font-size: 14px;"
                          />
                          <div style={directiveSendBtnStyle} onClick={sendBreadcrumbDirective}>
                            Send
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {/* Content: root list or drilled-in person view */}
                {computed(() => {
                  const crumbStrs = peopleBreadcrumbs.get() || [];
                  const allProjects: Project[] = (items.get()?.projects || []).filter(Boolean) as Project[];
                  const allActions: NextAction[] = (items.get()?.actions || []).filter(Boolean) as NextAction[];
                  const allWaiting: WaitingItem[] = (items.get()?.waiting || []).filter(Boolean) as WaitingItem[];

                  if (crumbStrs.length === 0) {
                    // Root: flat list of people with drill-in if they have linked items
                    const peopleItems = displayPeople;
                    if (peopleItems.length === 0) {
                      return (
                        <div style={{ fontSize: "13px", color: color.tertiaryLabel, padding: "12px 0" }}>
                          No people
                        </div>
                      );
                    }
                    return peopleItems.map((p: Person, idx: number) => {
                      const linkedCount =
                        allProjects.filter((pr: Project) => pr.parentId === p.id).length +
                        allActions.filter((a: NextAction) => a.projectId === p.id).length +
                        allWaiting.filter((w: WaitingItem) => w.projectId === p.id).length;
                      return (
                        <div>
                          <div
                            id={cssId("si_", "people:" + idx)}
                            style={{ ...itemRowStyle, display: "flex", alignItems: "center", gap: "0px", cursor: "pointer" }}
                          >
                            {/* Item content — click to drill in (if has linked items) or select */}
                            <div
                              style={{ display: "flex", alignItems: "center", gap: "10px", flex: "1", cursor: "pointer" }}
                              onClick={() => linkedCount > 0 ? drillIntoPerson.send({ id: p.id, name: p.name }) : selectItem.send({ key: "people:" + idx })}
                            >
                              <span style={{ fontWeight: "600", flex: "1" }}>{p.name}</span>
                              <span style={{ fontSize: "12px", color: color.secondaryLabel, fontWeight: "400" }}>{p.role}</span>
                              <span
                                style={{
                                  padding: "2px 10px",
                                  borderRadius: "100px",
                                  fontSize: "11px",
                                  fontWeight: "500",
                                  background: "rgba(175, 82, 222, 0.12)",
                                  color: "#af52de",
                                  flexShrink: "0",
                                }}
                              >
                                {p.context}
                              </span>
                            </div>
                            {/* Drill-in chevron — visual indicator only (row click handles navigation) */}
                            {linkedCount > 0 ? (
                              <span style={{ paddingLeft: "8px", flexShrink: "0", display: "inline-flex", alignItems: "center" }}>
                                <span style={{ fontSize: "11px", color: color.tertiaryLabel, marginRight: "4px" }}>{linkedCount}</span>
                                <span style={{ fontSize: "14px", color: color.tertiaryLabel }}>{">"}</span>
                              </span>
                            ) : null}
                          </div>
                          <div id={cssId("tb_", "people:" + idx)} style={{ display: "none", gap: "8px", padding: "6px 0 8px" }}>
                            <div style={actionBtnDelete} onClick={() => deleteItem.send({ key: "people:" + idx })}>✕ Delete</div>
                            <div style={actionBtnDirective} onClick={openItemDirective}>→ Wish</div>
                          </div>
                        </div>
                      );
                    });
                  }

                  // Drilled into a person or project — show linked items recursively
                  const crumbStr = crumbStrs[crumbStrs.length - 1];
                  const bar = crumbStr.indexOf("|");
                  const currentId = bar >= 0 ? crumbStr.substring(0, bar) : crumbStr;
                  const isPersonLevel = currentId.startsWith("PPL:");

                  const projItems: Project[] = [...displayProjects].filter(Boolean);
                  const actItems: NextAction[] = displayActions;
                  const waitItems: WaitingItem[] = displayWaiting;
                  const hideCompleted = !showCompleted.get();
                  const isCompleted = (s: string) => s === "Done" || s === "Archived";
                  const linkedProjects = projItems.filter((pr: Project) => pr.parentId === currentId && !(hideCompleted && isCompleted(pr.status)));
                  const linkedActions = actItems.filter((a: NextAction) => a.projectId === currentId);
                  const linkedWaiting = isPersonLevel ? waitItems.filter((w: WaitingItem) => w.projectId === currentId) : [];

                  // Build project name -> noteUrl lookup from directives (same as Projects panel)
                  const currentSpace = status.get().spaceName || "GTDFeb26.2";
                  const allDirectives = [...(directives.get() || [])] as Directive[];
                  const personNotes: Record<string, string> = {};
                  for (const d of allDirectives) {
                    if (!d || !d.noteUrl) continue;
                    const m = d.text.match(/^Re:\s*(.+?)\s*\u2014/);
                    if (m && d.noteUrl) {
                      let url = d.noteUrl;
                      if (url.match(/^\/[^\/]+\/baedrei/)) url = "/" + currentSpace + url.substring(url.indexOf("/", 1));
                      personNotes[m[1]] = url;
                    }
                  }

                  // Completed directive responses for the current entity
                  const currentName = (bar >= 0 ? crumbStr.substring(bar + 1) : crumbStr);
                  const entityResponses = allDirectives.filter((d: Directive) => {
                    if (!d || d.status !== "done" || !d.response) return false;
                    const dm = d.text.match(/^Re:\s*(.+?)\s*\u2014/);
                    return dm && dm[1] === currentName;
                  });

                  if (linkedProjects.length === 0 && linkedActions.length === 0 && linkedWaiting.length === 0 && entityResponses.length === 0) {
                    return (
                      <div style={{ fontSize: "13px", color: color.tertiaryLabel, padding: "12px 0" }}>
                        {isPersonLevel
                          ? (<span>No linked items — tag projects with <strong>Parent: {currentId}</strong> or tag actions/waiting with <strong>[{currentId}]</strong>.</span>)
                          : "No items — use + New Project or + New Action below."}
                      </div>
                    );
                  }

                  return (
                    <div>
                      {linkedProjects.length > 0 ? (
                        <div>
                          <div style={groupHeaderStyle}>Projects</div>
                          {linkedProjects.map((pr: Project) => {
                            const prIdx = projItems.indexOf(pr);
                            const hasKids = projItems.some((p2: Project) => p2.parentId === pr.id) || actItems.some((a: NextAction) => a.projectId === pr.id);
                            const pk = "projects:" + prIdx;
                            return (
                              <div>
                                <div
                                  id={cssId("si_", pk)}
                                  style={{ ...itemRowStyle, display: "flex", alignItems: "center", gap: "0px", cursor: "pointer" }}
                                >
                                  <div
                                    style={{ display: "flex", alignItems: "center", gap: "10px", flex: "1", cursor: "pointer" }}
                                    onClick={() => hasKids ? drillIntoPerson.send({ id: pr.id, name: pr.name }) : selectItem.send({ key: pk })}
                                  >
                                    <span style={{ fontSize: "12px", color: color.tertiaryLabel, fontWeight: "500", minWidth: "32px", flexShrink: "0" }}>{pr.id}</span>
                                    <span style={{ flex: "1" }}>{pr.name}</span>
                                    <span style={{ padding: "2px 10px", borderRadius: "100px", fontSize: "11px", fontWeight: "500", background: pr.status === "Active" ? "rgba(52, 199, 89, 0.12)" : pr.status === "Done" ? "rgba(142, 142, 147, 0.12)" : "rgba(255, 149, 0, 0.12)", color: pr.status === "Active" ? "#34c759" : pr.status === "Done" ? "#8e8e93" : "#ff9500", flexShrink: "0" }}>
                                      {pr.status}
                                    </span>
                                  </div>
                                  {personNotes[pr.name] ? (
                                    <a href={personNotes[pr.name]} target="_blank" style={{ textDecoration: "none", fontSize: "16px", flexShrink: "0", cursor: "pointer", marginLeft: "4px" }}>
                                      {"📎"}
                                    </a>
                                  ) : null}
                                  {hasKids ? (
                                    <span style={{ fontSize: "14px", color: color.tertiaryLabel, paddingLeft: "8px", flexShrink: "0", cursor: "pointer" }} onClick={() => drillIntoPerson.send({ id: pr.id, name: pr.name })}>{">"}</span>
                                  ) : null}
                                </div>
                                <div id={cssId("tb_", pk)} style={{ display: "none", gap: "8px", padding: "6px 0 8px", flexWrap: "wrap" as const }}>
                                  <div style={actionBtnDone} onClick={() => markItemDone.send({ key: pk })}>✓ Done</div>
                                  <div style={actionBtnDelete} onClick={() => deleteItem.send({ key: pk })}>✕ Delete</div>
                                  <div style={actionBtnDirective} onClick={openItemDirective}>→ Wish</div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                      {linkedActions.length > 0 ? (
                        <div>
                          <div style={groupHeaderStyle}>Actions</div>
                          {linkedActions.map((a: NextAction) => {
                            const origIdx = actItems.indexOf(a);
                            return (
                              <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "5px 0 5px 12px", borderBottom: `0.5px solid ${color.separator}` }}>
                                <ct-checkbox
                                  checked={false}
                                  style="width: 15px; height: 15px; flex-shrink: 0; cursor: pointer;"
                                  onClick={() => markItemDone.send({ key: "actions:" + origIdx })}
                                />
                                {a.context ? (
                                  <span style={{ fontSize: "10px", color: color.blue, background: "rgba(0,122,255,0.08)", padding: "1px 6px", borderRadius: "100px", flexShrink: "0", fontWeight: "500" }}>{a.context}</span>
                                ) : null}
                                <span style={{ fontSize: "13px", color: color.secondaryLabel, flex: "1" }}>{a.text}</span>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                      {linkedWaiting.length > 0 ? (
                        <div>
                          <div style={groupHeaderStyle}>Waiting For</div>
                          {linkedWaiting.map((w: WaitingItem) => (
                            <div style={{ ...itemRowStyle, display: "flex", alignItems: "center", gap: "10px" }}>
                              <span style={{ flex: "1" }}>{w.description || w.entity}</span>
                              <span style={{ fontSize: "11px", color: color.tertiaryLabel, flexShrink: "0" }}>{w.entity}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {entityResponses.length > 0 ? (
                        <div>
                          <div style={groupHeaderStyle}>Wish Responses</div>
                          {entityResponses.map((dir: Directive) => {
                            const qMatch = dir.text.match(/^Re:\s*.+?\s*\u2014\s*(.+)$/);
                            const question = qMatch ? qMatch[1] : dir.text;
                            const dateStr = dir.createdAt
                              ? new Date(dir.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                              : "";
                            let noteLink = dir.noteUrl || "";
                            if (noteLink && noteLink.match(/^\/[^\/]+\/baedrei/)) noteLink = "/" + currentSpace + noteLink.substring(noteLink.indexOf("/", 1));
                            return (
                              <div style={{ ...itemRowStyle, padding: "10px 0" }}>
                                <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
                                  <span style={{
                                    padding: "2px 6px", borderRadius: "4px",
                                    fontSize: "10px", fontWeight: "600",
                                    background: "rgba(88, 86, 214, 0.12)",
                                    color: color.indigo, flexShrink: "0", marginTop: "2px",
                                  }}>{dir.id}</span>
                                  <div style={{ flex: "1" }}>
                                    <div style={{ fontSize: "13px", fontWeight: "500", color: color.label }}>
                                      {question}
                                    </div>
                                    <div style={{
                                      fontSize: "12px", color: color.secondaryLabel,
                                      marginTop: "4px", lineHeight: "1.5",
                                      whiteSpace: "pre-wrap" as const,
                                    }}>
                                      {dir.response}
                                    </div>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "6px" }}>
                                      {dateStr ? (
                                        <span style={{ fontSize: "11px", color: color.tertiaryLabel }}>{dateStr}</span>
                                      ) : null}
                                      {noteLink ? (
                                        <a href={noteLink} target="_blank" style={{
                                          fontSize: "11px", color: color.blue, textDecoration: "none",
                                        }}>{"📎 View note"}</a>
                                      ) : null}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {/* Add person / sub-item */}
                {computed(() => {
                  const isOpen = addItemOpen.get();
                  const crumbs = peopleBreadcrumbs.get() || [];
                  const inPersonView = crumbs.length > 0;
                  if (!isOpen) {
                    if (inPersonView) {
                      const addBtnStyle = { display: "inline-flex", alignItems: "center", gap: "5px", cursor: "pointer", color: color.blue, fontSize: "13px", fontWeight: "500", padding: "4px 0" };
                      return (
                        <div style={{ display: "flex", gap: "16px", marginTop: "10px" }}>
                          <div style={addBtnStyle} onClick={() => openAddSubItem.send({ itemType: "project" })}>
                            <span style={{ fontSize: "17px", fontWeight: "300", lineHeight: "1" }}>+</span>
                            <span>New Project</span>
                          </div>
                          <div style={addBtnStyle} onClick={() => openAddSubItem.send({ itemType: "action" })}>
                            <span style={{ fontSize: "17px", fontWeight: "300", lineHeight: "1" }}>+</span>
                            <span>New Action</span>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div style={{ marginTop: "10px", display: "inline-flex", alignItems: "center", gap: "5px", cursor: "pointer", color: color.blue, fontSize: "13px", fontWeight: "500", padding: "4px 0" }} onClick={openAddItem}>
                        <span style={{ fontSize: "17px", fontWeight: "300", lineHeight: "1" }}>+</span>
                        <span>New Person</span>
                      </div>
                    );
                  }
                  const itype = addItemType.get();
                  const lastCrumb = crumbs.length > 0 ? crumbs[crumbs.length - 1] : "";
                  const lastBar2 = lastCrumb.indexOf("|");
                  const lastId = lastBar2 >= 0 ? lastCrumb.substring(0, lastBar2) : lastCrumb;
                  const inProjectView = inPersonView && !lastId.startsWith("PPL:");
                  const placeholder = inPersonView ? (itype === "action" ? "New action..." : (inProjectView ? "New subproject..." : "New project for this person...")) : "New person...";
                  return (
                    <div style={{ display: "flex", gap: "8px", marginTop: "10px", alignItems: "center" }}>
                      <ct-textarea $value={addItemDraft} placeholder={placeholder} rows={1} style="flex: 1; border-radius: 10px; font-size: 14px;" />
                      <div style={{ padding: "7px 16px", borderRadius: "100px", fontSize: "13px", fontWeight: "600", background: color.blue, color: "#fff", cursor: "pointer", flexShrink: "0" }} onClick={sendAddItem}>Add</div>
                      <div style={{ padding: "7px 10px", borderRadius: "100px", fontSize: "13px", color: color.secondaryLabel, cursor: "pointer", flexShrink: "0" }} onClick={() => { addItemOpen.set(false); addItemDraft.set(""); addItemType.set(""); }}>Cancel</div>
                    </div>
                  );
                })}
              </div>
              );
              if (panel === "things") return (
              <div style={panelCardStyle}>
                {computed(() => {
                  const allThings: ThingItem[] = (items.get()?.things || []).filter(Boolean) as ThingItem[];
                  const crumbs = thingsBreadcrumbs.get() || [];

                  // Navigate to current level
                  let currentItems = allThings;
                  for (const crumb of crumbs) {
                    const found = currentItems.find((t: ThingItem) => t.name === crumb);
                    if (found && found.children) {
                      currentItems = found.children;
                    } else {
                      break;
                    }
                  }

                  const folders = currentItems.filter((t: ThingItem) => t.type === "folder");
                  const files = currentItems.filter((t: ThingItem) => t.type === "file");

                  // Breadcrumb bar
                  const dirOpen = crumbs.length > 0 ? breadcrumbDirectiveOpen.get() : false;
                  const breadcrumbBar = (
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" as const, marginBottom: "8px" }}>
                        <span
                          style={{ fontSize: "15px", fontWeight: "600", cursor: crumbs.length > 0 ? "pointer" : "default", color: crumbs.length > 0 ? color.blue : color.label }}
                          onClick={() => { if (crumbs.length > 0) thingsBreadcrumbs.set([]); }}
                        >
                          Things
                        </span>
                        {crumbs.map((c: string, i: number) => (
                          <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            <span style={{ fontSize: "11px", color: color.tertiaryLabel }}>/</span>
                            <span
                              style={{ fontSize: "15px", fontWeight: i === crumbs.length - 1 ? "600" : "500", cursor: i < crumbs.length - 1 ? "pointer" : "default", color: i < crumbs.length - 1 ? color.blue : color.label }}
                              onClick={() => { if (i < crumbs.length - 1) thingsBreadcrumbs.set(crumbs.slice(0, i + 1)); }}
                            >
                              {c}
                            </span>
                          </span>
                        ))}
                        {crumbs.length > 0 ? (
                          <div
                            style={{ marginLeft: "auto", ...actionBtnDirective, fontSize: "11px", padding: "3px 10px" }}
                            onClick={() => openBreadcrumbDirective.send({ prefix: "Re: Things/" + crumbs.join("/") + " — ", ctx: "things" })}
                          >
                            → Wish
                          </div>
                        ) : null}
                      </div>
                      {dirOpen ? (
                        <div style={{ ...directiveInputRowStyle, marginBottom: "8px" }}>
                          <ct-textarea
                            $value={breadcrumbDirectiveDraft}
                            placeholder={"Wish about " + crumbs[crumbs.length - 1] + "..."}
                            rows={1}
                            style="flex: 1; border-radius: 10px; font-size: 14px;"
                          />
                          <div style={directiveSendBtnStyle} onClick={sendBreadcrumbDirective}>
                            Send
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );

                  if (folders.length === 0 && files.length === 0) {
                    return (
                      <div>
                        {breadcrumbBar}
                        <div style={{ fontSize: "13px", color: color.tertiaryLabel, padding: "12px 0" }}>
                          {crumbs.length > 0 ? "Empty folder" : "No things data synced yet"}
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div>
                      {breadcrumbBar}
                      {folders.map((t: ThingItem) => {
                        const thingKey = "things:" + [...crumbs, t.name].join("/");
                        return (
                          <div>
                            <div
                              id={cssId("si_", thingKey)}
                              style={{ ...itemRowStyle, cursor: "pointer", display: "flex", alignItems: "center", gap: "8px" }}
                            >
                              <span style={{ fontSize: "16px", flexShrink: "0", opacity: 0.6 }} onClick={() => thingsBreadcrumbs.set([...crumbs, t.name])}>{">"}</span>
                              <span style={{ fontWeight: "500", flex: "1", cursor: "pointer" }} onClick={() => thingsBreadcrumbs.set([...crumbs, t.name])}>{t.name}</span>
                              {(t.itemCount || 0) > 0 ? (
                                <span style={{ fontSize: "11px", color: color.tertiaryLabel, flexShrink: "0" }}>
                                  {t.itemCount} {(t.itemCount || 0) === 1 ? "item" : "items"}
                                </span>
                              ) : null}
                              <span
                                style={{ fontSize: "14px", color: color.tertiaryLabel, cursor: "pointer", padding: "0 4px", flexShrink: "0" }}
                                onClick={() => selectItem.send({ key: thingKey })}
                              >
                                {"···"}
                              </span>
                            </div>
                            <div id={cssId("tb_", thingKey)} style={{ display: "none", gap: "8px", padding: "6px 0 8px" }}>
                              <div style={actionBtnDirective} onClick={openItemDirective}>→ Wish</div>
                            </div>
                          </div>
                        );
                      })}
                      {files.map((t: ThingItem) => (
                        <div style={{ ...itemRowStyle, display: "flex", alignItems: "center", gap: "8px" }}>
                          <span style={{ fontSize: "13px", flexShrink: "0", opacity: 0.4 }}>-</span>
                          <span style={{ color: color.secondaryLabel }}>{t.name}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
              );
              return null;
            })}
          </div>

          {/* ── Item Directive Input (shared across all panels) ── */}
          {computed(() => {
            const sel = selectedItem.get();
            if (!sel || !itemDirectiveOpen.get()) return null;
            return (
              <div style={{ padding: "0 16px", marginBottom: "8px" }}>
                <div style={directiveInputRowStyle}>
                  <ct-textarea $value={itemDirectiveDraft} placeholder="Wish about this item..." rows={1} style="flex: 1; border-radius: 10px; font-size: 14px;" />
                  <div style={directiveSendBtnStyle} onClick={sendItemDirective}>Send</div>
                </div>
              </div>
            );
          })}

          {/* ── Question Tabs (Segmented control) ── */}
          <div style={{ padding: "0 16px", marginBottom: "0" }}>
            {/* Segmented control */}
            <div
              style={{
                display: "flex",
                background: color.fillPrimary,
                borderRadius: "9px",
                padding: "2px",
                marginBottom: "16px",
              }}
            >
              <div
                style={computed(() => ({
                  flex: "1",
                  textAlign: "center" as const,
                  padding: "6px 0",
                  fontSize: "13px",
                  fontWeight: filterStatus.get() === "pending" ? "600" : "400",
                  color:
                    filterStatus.get() === "pending"
                      ? color.label
                      : color.secondaryLabel,
                  background:
                    filterStatus.get() === "pending"
                      ? color.background
                      : "transparent",
                  borderRadius: "7px",
                  boxShadow:
                    filterStatus.get() === "pending"
                      ? "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)"
                      : "none",
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                }))}
                onClick={() => filterStatus.set("pending")}
              >
                Pending ({pendingCount})
              </div>
              <div
                style={computed(() => ({
                  flex: "1",
                  textAlign: "center" as const,
                  padding: "6px 0",
                  fontSize: "13px",
                  fontWeight: filterStatus.get() === "answered" ? "600" : "400",
                  color:
                    filterStatus.get() === "answered"
                      ? color.label
                      : color.secondaryLabel,
                  background:
                    filterStatus.get() === "answered"
                      ? color.background
                      : "transparent",
                  borderRadius: "7px",
                  boxShadow:
                    filterStatus.get() === "answered"
                      ? "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)"
                      : "none",
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                }))}
                onClick={() => filterStatus.set("answered")}
              >
                Answered ({answeredCount})
              </div>
              <div
                style={computed(() => ({
                  flex: "1",
                  textAlign: "center" as const,
                  padding: "6px 0",
                  fontSize: "13px",
                  fontWeight: filterStatus.get() === "all" ? "600" : "400",
                  color:
                    filterStatus.get() === "all"
                      ? color.label
                      : color.secondaryLabel,
                  background:
                    filterStatus.get() === "all"
                      ? color.background
                      : "transparent",
                  borderRadius: "7px",
                  boxShadow:
                    filterStatus.get() === "all"
                      ? "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)"
                      : "none",
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                }))}
                onClick={() => filterStatus.set("all")}
              >
                All ({computed(() => displayQuestions.length)})
              </div>
            </div>
          </div>

          {/* ── Question List ── */}
          <div style={{ padding: "0 16px 12px", overflow: "auto" }}>
            {computed(() => {
              const f = filterStatus.get();
              const visible = displayQuestions.filter((q: Question) => f === "all" || q.status === f);
              return visible.map((item: Question) => (
                <div
                  style={{
                    background: color.background,
                    borderRadius: "14px",
                    padding: "16px 18px",
                    marginBottom: "10px",
                    boxShadow:
                      "0 0.5px 0 rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.04)",
                  }}
                >
                  {/* Meta row */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      marginBottom: "8px",
                    }}
                  >
                    <div
                      style={computed(() => ({
                        width: "8px",
                        height: "8px",
                        borderRadius: "50%",
                        background:
                          priorityDots[item.priority] || priorityDots.low,
                        flexShrink: "0",
                      }))}
                    />
                    <span
                      style={computed(() => {
                        const t = categoryTints[item.category] ||
                          categoryTints.general;
                        return {
                          display: "inline-block",
                          padding: "2px 10px",
                          borderRadius: "100px",
                          fontSize: "12px",
                          fontWeight: "500",
                          background: t.bg,
                          color: t.fg,
                        };
                      })}
                    >
                      {item.category}
                    </span>
                    <span
                      style={{
                        fontSize: "12px",
                        color: color.tertiaryLabel,
                        marginLeft: "auto",
                      }}
                    >
                      {item.source}
                    </span>
                  </div>

                  <div
                    style={{
                      fontSize: "15px",
                      fontWeight: "500",
                      lineHeight: "1.4",
                      letterSpacing: "-0.15px",
                      marginBottom: "6px",
                    }}
                  >
                    {item.question}
                  </div>

                  {item.context !== undefined && item.context !== "" ? (
                    <div style={{ fontSize: "13px", lineHeight: "1.45", color: color.secondaryLabel, marginBottom: "12px" }}>
                      {item.context}
                    </div>
                  ) : null}

                  {/* Pending actions */}
                  {item.status === "pending" ? (
                    <div>
                      {item.options !== undefined && item.options.length > 0 ? (
                        <div style={{ display: "flex", flexWrap: "wrap" as const, gap: "6px", marginBottom: "10px" }}>
                          {item.options.map((opt: string) => (
                            <div
                              style={{ padding: "6px 14px", borderRadius: "100px", fontSize: "13px", fontWeight: "500", background: "rgba(0, 122, 255, 0.1)", color: color.blue, cursor: "pointer" }}
                              onClick={() => answerQuestion.send({ id: item.id, answer: opt, author: "human-lead" })}
                            >
                              {opt}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <div style={{ display: "flex", gap: "8px" }}>
                        <div style={{ padding: "7px 16px", borderRadius: "100px", fontSize: "13px", fontWeight: "600", background: color.blue, color: "#fff", cursor: "pointer" }} onClick={() => selectQuestion.send({ id: item.id })}>Reply</div>
                        <div style={{ padding: "7px 16px", borderRadius: "100px", fontSize: "13px", fontWeight: "500", color: color.secondaryLabel, cursor: "pointer" }} onClick={() => dismissQuestion.send({ id: item.id })}>Dismiss</div>
                      </div>
                    </div>
                  ) : null}

                  {/* Answered state */}
                  {item.status === "answered" ? (
                    <div>
                      <div style={{ padding: "10px 12px", background: color.fillTertiary, borderRadius: "10px", marginBottom: "6px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                          <span style={{ fontSize: "12px", fontWeight: "600", color: color.blue }}>{item.answeredBy}</span>
                          <span style={{ fontSize: "11px", color: color.tertiaryLabel }}>{item.answeredAt}</span>
                        </div>
                        <div style={{ fontSize: "14px", lineHeight: "1.45", color: color.label }}>{item.answer}</div>
                      </div>

                      {item.replies !== undefined && item.replies.length > 0 ? (
                        <div style={{ borderLeft: `2px solid ${color.separator}`, marginLeft: "12px", paddingLeft: "12px" }}>
                          {item.replies.map((reply: Reply) => (
                            <div style={{ padding: "8px 10px", background: color.fillTertiary, borderRadius: "8px", marginBottom: "4px" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2px" }}>
                                <span style={{ fontSize: "12px", fontWeight: "600", color: reply.author === "human-lead" ? color.green : color.blue }}>{reply.author}</span>
                                <span style={{ fontSize: "10px", color: color.tertiaryLabel }}>{reply.at}</span>
                              </div>
                              <div style={{ fontSize: "13px", lineHeight: "1.4", color: color.label }}>{reply.text}</div>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                        <div
                          style={{
                            padding: "5px 14px",
                            borderRadius: "100px",
                            fontSize: "12px",
                            fontWeight: "500",
                            color: color.blue,
                            cursor: "pointer",
                            background: "rgba(0, 122, 255, 0.08)",
                          }}
                          onClick={() =>
                            reopenQuestion.send({ id: item.id })
                          }
                        >
                          Add Reply
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              ));
            })}

            {/* Empty state */}
            {ifElse(
              computed(() => {
                const f = filterStatus.get();
                const all = displayQuestions;
                const count =
                  f === "all"
                    ? all.length
                    : all.filter((q: Question) => q.status === f).length;
                return count === 0;
              }),
              <div
                style={{
                  textAlign: "center",
                  padding: "48px 24px",
                  color: color.tertiaryLabel,
                }}
              >
                {ifElse(
                  computed(() => filterStatus.get() === "pending"),
                  <div>
                    <div
                      style={{
                        fontSize: "32px",
                        marginBottom: "8px",
                        opacity: "0.5",
                      }}
                    >
                      checkmark.circle
                    </div>
                    <div
                      style={{
                        fontSize: "17px",
                        fontWeight: "600",
                        color: color.secondaryLabel,
                      }}
                    >
                      All Clear
                    </div>
                    <div style={{ fontSize: "13px", marginTop: "4px" }}>
                      No pending questions
                    </div>
                  </div>,
                  <div style={{ fontSize: "15px" }}>
                    No questions match this filter
                  </div>,
                )}
              </div>,
              null,
            )}
          </div>

          {/* ── Reply Sheet ── */}
          {ifElse(
            computed(() => selectedId.get() !== ""),
            <div
              style={{
                position: "fixed" as const,
                bottom: "0",
                left: "0",
                right: "0",
                background: color.background,
                borderTop: `0.5px solid ${color.separator}`,
                boxShadow: "0 -4px 20px rgba(0,0,0,0.08)",
                borderRadius: "16px 16px 0 0",
                padding: "16px 20px 24px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "10px",
                }}
              >
                <span
                  style={{
                    fontSize: "13px",
                    fontWeight: "600",
                    color: color.blue,
                  }}
                >
                  {selectedQuestionId}
                </span>
                <div
                  style={{
                    fontSize: "13px",
                    color: color.blue,
                    cursor: "pointer",
                    fontWeight: "400",
                  }}
                  onClick={() => {
                    selectedId.set("");
                    draftAnswer.set("");
                  }}
                >
                  Cancel
                </div>
              </div>
              <div
                style={{
                  fontSize: "14px",
                  color: color.secondaryLabel,
                  marginBottom: "12px",
                  lineHeight: "1.4",
                }}
              >
                {selectedQuestionText}
              </div>
              <ct-textarea
                $value={draftAnswer}
                placeholder="Type your answer..."
                rows={3}
                style="border-radius: 10px; margin-bottom: 10px;"
              />
              <div
                style={{
                  padding: "10px 0",
                  borderRadius: "12px",
                  fontSize: "15px",
                  fontWeight: "600",
                  background: color.blue,
                  color: "#fff",
                  textAlign: "center" as const,
                  cursor: "pointer",
                }}
                onClick={submitDraft}
              >
                Submit
              </div>
            </div>,
            null,
          )}
        </div>
      ),
      userActions,
      pendingCount,
      answeredCount,
    };
  },
);

export default GTDDashboard;
