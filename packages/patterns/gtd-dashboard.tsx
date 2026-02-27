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

interface StatusData {
  inboxCount: number;
  projectCount: number;
  waitingForCount: number;
  nextActionCount: number;
  lastSync: string;
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
  createdAt: string;
  status: string;
  response: string;
  assignedTo: string;
  noteUrl: string;
}

interface Items {
  inbox: InboxItem[];
  projects: Project[];
  people: Person[];
  waiting: WaitingItem[];
  actions: NextAction[];
}

interface UserAction {
  type: string;
  panel?: string;
  text?: string;
  questionId?: string;
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
  fillPrimary: "rgba(120, 120, 128, 0.08)",
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
  background: "rgba(88, 86, 214, 0.12)",
  color: "#5856d6",
  cursor: "pointer",
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
    const expandedContext = Writable.of<string>("");

    // Command state
    const dispatchOpen = Writable.of<boolean>(false);
    const dispatchDraft = Writable.of<string>("");

    // Breadcrumb navigation state for Projects panel
    // Stores "id|name" strings — simple array to avoid reactive serialization issues
    const projectBreadcrumbs = Writable.of<string[]>([]);

    // Show/hide Done and Archived items (defaults to hidden)
    const showCompleted = Writable.of<boolean>(false);

    // Sync button state
    const syncPending = Writable.of<boolean>(false);
    const syncTriggeredAt = Writable.of<string>("");

    // Actions queue — all user mutations go here, sync script processes them
    const userActions = Writable.of<UserAction[]>([]);

    // Per-item selection state
    const selectedItem = Writable.of<string>("");
    const itemDirectiveDraft = Writable.of<string>("");
    const itemDirectiveOpen = Writable.of<boolean>(false);

    // Display computeds — read-only inputs filtered/augmented by local actions
    // Key invariant: sync push is authoritative. After a sync, the file data is truth.
    // Only userActions that happened AFTER the last sync should augment the display.
    const displayInbox = computed(() => {
      const raw = items.get()?.inbox || [];
      const acts = userActions.get();
      const lastSyncTs = status.get()?.lastSync || "";
      const dels = new Set(acts.filter((a: UserAction) => (a.type === "delete" || a.type === "done") && a.panel === "inbox" && (!lastSyncTs || a.ts > lastSyncTs)).map((a: UserAction) => a.text || ""));
      const adds = acts.filter((a: UserAction) => a.type === "add" && a.panel === "inbox" && (!lastSyncTs || a.ts > lastSyncTs));
      const filtered = raw.filter((i: InboxItem) => !dels.has(i.text));
      // Deduplicate: skip adds already present in raw (sync may have persisted them)
      const existing = new Set(raw.map((i: InboxItem) => i.text));
      const newAdds = adds.filter((a: UserAction) => !existing.has(a.text || "") && !dels.has(a.text || ""));
      return [...filtered, ...newAdds.map((a: UserAction) => ({ text: a.text || "", done: false }))];
    });

    const displayPeople = computed(() => {
      const raw = items.get()?.people || [];
      const acts = userActions.get();
      const dels = new Set(acts.filter((a: UserAction) => (a.type === "delete" || a.type === "done") && a.panel === "people").map((a: UserAction) => a.text || ""));
      return raw.filter((p: Person) => !dels.has(p.name));
    });

    const displayWaiting = computed(() => {
      const raw = items.get()?.waiting || [];
      const acts = userActions.get();
      const dels = new Set(acts.filter((a: UserAction) => (a.type === "delete" || a.type === "done") && a.panel === "waiting").map((a: UserAction) => a.text || ""));
      return raw.filter((w: WaitingItem) => !dels.has(w.entity));
    });

    const displayActions = computed(() => {
      const raw = items.get()?.actions || [];
      const acts = userActions.get();
      const dels = new Set(acts.filter((a: UserAction) => (a.type === "delete" || a.type === "done") && a.panel === "actions").map((a: UserAction) => a.text || ""));
      return raw.filter((a: NextAction) => !dels.has(a.text));
    });

    const displayQuestions = computed(() => {
      const raw = questions.get();
      const acts = userActions.get();
      return raw.map((q: Question) => {
        const dismiss = acts.find((a: UserAction) => a.type === "dismiss" && a.questionId === q.id);
        if (dismiss) return { ...q, status: "answered", answer: "[dismissed]", answeredBy: "human-lead", answeredAt: dismiss.ts };
        const ans = acts.find((a: UserAction) => a.type === "answer" && a.questionId === q.id);
        if (ans) return { ...q, status: "answered", answer: ans.answer || "", answeredBy: ans.author || "", answeredAt: ans.ts };
        const replies = acts.filter((a: UserAction) => a.type === "reply" && a.questionId === q.id);
        if (replies.length > 0) {
          // Deduplicate: skip replies already present in raw data (sync may have persisted them)
          const existingReplies = new Set((q.replies || []).map((r: Reply) => r.text + "|" + r.at));
          const newReplies = replies.filter((r: UserAction) => !existingReplies.has((r.text || "") + "|" + r.ts));
          if (newReplies.length > 0) return { ...q, replies: [...(q.replies || []), ...newReplies.map((r: UserAction) => ({ text: r.text || "", author: r.author || "", at: r.ts }))] };
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

    // Stat card computed styles (one per card, no helper functions)
    const inboxCardStyle = computed(() => ({
      background:
        expandedPanel.get() === "inbox"
          ? "rgba(0, 122, 255, 0.08)"
          : color.fillPrimary,
      borderRadius: "12px",
      padding: "12px 14px",
      cursor: "pointer",
      transition: "background 0.2s ease",
      border:
        expandedPanel.get() === "inbox"
          ? "1px solid rgba(0, 122, 255, 0.2)"
          : "1px solid transparent",
    }));

    const projectsCardStyle = computed(() => ({
      background:
        expandedPanel.get() === "projects"
          ? "rgba(0, 122, 255, 0.08)"
          : color.fillPrimary,
      borderRadius: "12px",
      padding: "12px 14px",
      cursor: "pointer",
      transition: "background 0.2s ease",
      border:
        expandedPanel.get() === "projects"
          ? "1px solid rgba(0, 122, 255, 0.2)"
          : "1px solid transparent",
    }));

    const peopleCardStyle = computed(() => ({
      background:
        expandedPanel.get() === "people"
          ? "rgba(0, 122, 255, 0.08)"
          : color.fillPrimary,
      borderRadius: "12px",
      padding: "12px 14px",
      cursor: "pointer",
      transition: "background 0.2s ease",
      border:
        expandedPanel.get() === "people"
          ? "1px solid rgba(0, 122, 255, 0.2)"
          : "1px solid transparent",
    }));

    const waitingCardStyle = computed(() => ({
      background:
        expandedPanel.get() === "waiting"
          ? "rgba(0, 122, 255, 0.08)"
          : color.fillPrimary,
      borderRadius: "12px",
      padding: "12px 14px",
      cursor: "pointer",
      transition: "background 0.2s ease",
      border:
        expandedPanel.get() === "waiting"
          ? "1px solid rgba(0, 122, 255, 0.2)"
          : "1px solid transparent",
    }));

    const actionsCardStyle = computed(() => ({
      background:
        expandedPanel.get() === "actions"
          ? "rgba(0, 122, 255, 0.08)"
          : color.fillPrimary,
      borderRadius: "12px",
      padding: "12px 14px",
      cursor: "pointer",
      transition: "background 0.2s ease",
      border:
        expandedPanel.get() === "actions"
          ? "1px solid rgba(0, 122, 255, 0.2)"
          : "1px solid transparent",
    }));

    const inboxChevron = computed(() => ({
      fontSize: "10px",
      color: color.tertiaryLabel,
      transition: "transform 0.2s ease",
      transform:
        expandedPanel.get() === "inbox" ? "rotate(90deg)" : "rotate(0deg)",
      marginLeft: "auto",
      flexShrink: "0",
    }));

    const projectsChevron = computed(() => ({
      fontSize: "10px",
      color: color.tertiaryLabel,
      transition: "transform 0.2s ease",
      transform:
        expandedPanel.get() === "projects"
          ? "rotate(90deg)"
          : "rotate(0deg)",
      marginLeft: "auto",
      flexShrink: "0",
    }));

    const peopleChevron = computed(() => ({
      fontSize: "10px",
      color: color.tertiaryLabel,
      transition: "transform 0.2s ease",
      transform:
        expandedPanel.get() === "people"
          ? "rotate(90deg)"
          : "rotate(0deg)",
      marginLeft: "auto",
      flexShrink: "0",
    }));

    const waitingChevron = computed(() => ({
      fontSize: "10px",
      color: color.tertiaryLabel,
      transition: "transform 0.2s ease",
      transform:
        expandedPanel.get() === "waiting" ? "rotate(90deg)" : "rotate(0deg)",
      marginLeft: "auto",
      flexShrink: "0",
    }));

    const actionsChevron = computed(() => ({
      fontSize: "10px",
      color: color.tertiaryLabel,
      transition: "transform 0.2s ease",
      transform:
        expandedPanel.get() === "actions" ? "rotate(90deg)" : "rotate(0deg)",
      marginLeft: "auto",
      flexShrink: "0",
    }));

    const togglePanel = action(({ panel }: { panel: string }) => {
      const current = expandedPanel.get();
      expandedPanel.set(current === panel ? "" : panel);
    });

    const toggleContext = action(({ ctx }: { ctx: string }) => {
      const current = expandedContext.get();
      expandedContext.set(current === ctx ? "" : ctx);
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
      if (current) dispatchDraft.set("");
    });

    const sendDispatch = action(() => {
      const text = dispatchDraft.get().trim();
      if (!text) return;
      const now = new Date().toISOString();
      userActions.set([...userActions.get(), { type: "directive", target: "system", text: "Command: " + text, ts: now }]);
      dispatchDraft.set("");
      dispatchOpen.set(false);
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
    });

    // Per-item actions
    const selectItem = action(({ key }: { key: string }) => {
      const current = selectedItem.get();
      selectedItem.set(current === key ? "" : key);
      itemDirectiveOpen.set(false);
      itemDirectiveDraft.set("");
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
      } else if (panel === "actions") {
        const item = displayActions[idx];
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
      if (panel === "inbox") {
        const item = displayInbox[idx];
        if (item) text = item.text;
      } else if (panel === "waiting") {
        const item = displayWaiting[idx];
        if (item) text = item.entity;
      } else if (panel === "people") {
        const item = displayPeople[idx];
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

    const openItemDirective = action(() => {
      itemDirectiveOpen.set(true);
    });

    const sendItemDirective = action(() => {
      const key = selectedItem.get();
      if (!key) return;
      const text = itemDirectiveDraft.get().trim();
      if (!text) return;

      const [panel, idxStr] = [key.split(":")[0], key.split(":")[1]];
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
        const item = (items.get()?.projects || [])[idx];
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
      }

      const now = new Date().toISOString();
      userActions.set([...userActions.get(), { type: "directive", target, text: prefix + text, ts: now }]);

      itemDirectiveDraft.set("");
      itemDirectiveOpen.set(false);
      selectedItem.set("");
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
                  style={computed(() => {
                    const pending = syncPending.get();
                    const triggered = syncTriggeredAt.get();
                    const last = status.get().lastSync;
                    const isSyncing = pending && (!last || triggered > last);
                    return {
                      padding: "5px 14px",
                      borderRadius: "100px",
                      fontSize: "13px",
                      fontWeight: "600",
                      background: isSyncing ? color.green : "rgba(52, 199, 89, 0.1)",
                      color: isSyncing ? "#fff" : color.green,
                      cursor: "pointer",
                      transition: "all 0.3s ease",
                    };
                  })}
                  onClick={syncNow}
                >
                  {computed(() => {
                    const pending = syncPending.get();
                    const triggered = syncTriggeredAt.get();
                    const last = status.get().lastSync;
                    const isSyncing = pending && (!last || triggered > last);
                    return isSyncing ? "Syncing\u2026" : "Sync";
                  })}
                </div>
                <div
                  style={computed(() => ({
                    padding: "5px 14px",
                    borderRadius: "100px",
                    fontSize: "13px",
                    fontWeight: "600",
                    background: dispatchOpen.get()
                      ? color.indigo
                      : "rgba(88, 86, 214, 0.1)",
                    color: dispatchOpen.get() ? "#fff" : color.indigo,
                    cursor: "pointer",
                    transition: "all 0.2s ease",
                  }))}
                  onClick={toggleDispatch}
                >
                  Command
                </div>
                <span
                  style={{
                    fontSize: "12px",
                    color: color.tertiaryLabel,
                    fontWeight: "400",
                  }}
                >
                  {computed(() => {
                    const s = status.get();
                    return s.lastSync ? `Synced ${s.lastSync}` : "";
                  })}
                </span>
              </div>
            </div>

            {/* Command input row */}
            {ifElse(
              computed(() => dispatchOpen.get()),
              <div
                style={{
                  display: "flex",
                  gap: "8px",
                  marginBottom: "12px",
                  alignItems: "center",
                }}
              >
                <ct-textarea
                  $value={dispatchDraft}
                  placeholder="What needs attention?"
                  rows={1}
                  style={{
                    flex: "1",
                    borderRadius: "10px",
                    fontSize: "14px",
                  }}
                />
                <div
                  style={directiveSendBtnStyle}
                  onClick={sendDispatch}
                >
                  Send
                </div>
              </div>,
              null,
            )}

            {/* Stat widgets — tappable */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr",
                gap: "10px",
                marginBottom: "16px",
              }}
            >
              {/* Inbox card */}
              <div
                style={inboxCardStyle}
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
                  <span style={inboxChevron}>▶</span>
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
                style={projectsCardStyle}
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
                      const all = items.get()?.projects || [];
                      if (showCompleted.get()) return all.length;
                      return all.filter((p: Project) => p.status !== "Done" && p.status !== "Archived").length;
                    })}
                  </div>
                  <span style={projectsChevron}>▶</span>

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
                style={peopleCardStyle}
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
                  <span style={peopleChevron}>▶</span>
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
              {/* Waiting card */}
              <div
                style={waitingCardStyle}
                onClick={() => togglePanel.send({ panel: "waiting" })}
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
                    {computed(() => displayWaiting.length)}
                  </div>
                  <span style={waitingChevron}>▶</span>
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
                  Waiting
                </div>
              </div>
              {/* Actions card */}
              <div
                style={actionsCardStyle}
                onClick={() => togglePanel.send({ panel: "actions" })}
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
                      const all = displayActions;
                      if (showCompleted.get()) return all.length;
                      const projectItems: Project[] = items.get()?.projects || [];
                      const completedIds = new Set(projectItems.filter((p: Project) => p.status === "Done" || p.status === "Archived").map((p: Project) => p.id));
                      if (completedIds.size === 0) return all.length;
                      return all.filter((a: NextAction) => !a.projectId || !completedIds.has(a.projectId)).length;
                    })}
                  </div>
                  <span style={actionsChevron}>▶</span>
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
                  Actions
                </div>
              </div>
            </div>

            {/* Directive History — shows completed directives with note links */}
            {computed(() => {
              const dirs: Directive[] = [...(directives.get() || [])].filter((d: Directive) => d && d.id);
              const done = dirs.filter((d: Directive) => d.status === "done");
              if (done.length === 0) return null;

              // Show most recent 10
              const recent = done.slice(0, 10);
              return (
                <div style={{ marginBottom: "16px" }}>
                  <div style={{ fontSize: "11px", fontWeight: "600", color: color.secondaryLabel, textTransform: "uppercase" as const, letterSpacing: "0.5px", marginBottom: "8px" }}>
                    Recent Directives
                  </div>
                  {recent.map((d: Directive) => (
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 0", borderBottom: "0.5px solid " + color.separator }}>
                      <span style={{ fontSize: "11px", color: color.tertiaryLabel, fontWeight: "500", minWidth: "40px", flexShrink: "0" }}>{d.id}</span>
                      <span style={{ fontSize: "13px", color: color.label, flex: "1", overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const }}>{d.text}</span>
                      {d.assignedTo ? <span style={{ fontSize: "10px", color: color.secondaryLabel, padding: "1px 6px", borderRadius: "100px", background: color.fillPrimary }}>{d.assignedTo}</span> : null}
                      {d.noteUrl ? (
                        <a href={d.noteUrl} target="_blank" style={{ textDecoration: "none", fontSize: "16px", flexShrink: "0", cursor: "pointer" }}>
                          {"📎"}
                        </a>
                      ) : null}
                    </div>
                  ))}
                </div>
              );
            })}

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

          {/* ── Expanded Panels (accordion) ── */}
          <div style={{ padding: "12px 16px 0" }}>
            {/* Inbox Panel */}
            {ifElse(
              computed(() => expandedPanel.get() === "inbox"),
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
                  return inboxItems.map((item: InboxItem, idx: number) => (
                    <div>
                      <div
                        style={computed(() =>
                          selectedItem.get() === "inbox:" + idx
                            ? {
                                ...itemRowStyle,
                                cursor: "pointer",
                                background: "rgba(0, 122, 255, 0.06)",
                                borderRadius: "8px",
                                padding: "8px",
                              }
                            : { ...itemRowStyle, cursor: "pointer" },
                        )}
                        onClick={() =>
                          selectItem.send({ key: "inbox:" + idx })
                        }
                      >
                        <span
                          style={{
                            display: "inline-block",
                            width: "14px",
                            height: "14px",
                            borderRadius: "50%",
                            border: item.done
                              ? `2px solid ${color.green}`
                              : `2px solid ${color.tertiaryLabel}`,
                            background: item.done ? color.green : "transparent",
                            marginRight: "10px",
                            verticalAlign: "middle",
                          }}
                        />
                        <span
                          style={{
                            verticalAlign: "middle",
                            color: item.done ? color.tertiaryLabel : color.label,
                          }}
                        >
                          {item.text}
                        </span>
                      </div>
                      {ifElse(
                        computed(
                          () => selectedItem.get() === "inbox:" + idx,
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
                              style={actionBtnDone}
                              onClick={() =>
                                markItemDone.send({ key: "inbox:" + idx })
                              }
                            >
                              ✓ Done
                            </div>
                            <div
                              style={actionBtnDelete}
                              onClick={() =>
                                deleteItem.send({ key: "inbox:" + idx })
                              }
                            >
                              ✕ Delete
                            </div>
                            <div
                              style={actionBtnDirective}
                              onClick={openItemDirective}
                            >
                              → Directive
                            </div>
                          </div>
                          {ifElse(
                            computed(() => itemDirectiveOpen.get()),
                            <div style={directiveInputRowStyle}>
                              <ct-textarea
                                $value={itemDirectiveDraft}
                                placeholder="Directive about this item..."
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
                  ));
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
                    style={{
                      flex: "1",
                      borderRadius: "10px",
                      fontSize: "14px",
                    }}
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
              </div>,
              null,
            )}

            {/* Projects Panel — Breadcrumb Drill-Down */}
            {ifElse(
              computed(() => expandedPanel.get() === "projects"),
              <div style={panelCardStyle}>
                {/* Breadcrumb bar */}
                {computed(() => {
                  const crumbStrs = projectBreadcrumbs.get() || [];
                  if (crumbStrs.length === 0) {
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
                  // Parse "id|name" strings
                  const crumbs = crumbStrs.map((s: string) => {
                    const bar = s.indexOf("|");
                    return { id: bar >= 0 ? s.substring(0, bar) : s, name: bar >= 0 ? s.substring(bar + 1) : s };
                  });
                  return (
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
                    </div>
                  );
                })}
                {computed(() => {
                  const projectItems: Project[] = items.get()?.projects || [];
                  const peopleItems: Person[] = items.get()?.people || [];
                  const crumbStrs2 = projectBreadcrumbs.get() || [];
                  const crumbs = crumbStrs2.map((s: string) => {
                    const bar = s.indexOf("|");
                    return { id: bar >= 0 ? s.substring(0, bar) : s, name: bar >= 0 ? s.substring(bar + 1) : s };
                  });

                  // Build project name -> noteUrl lookup from directives
                  const projectNotes: Record<string, string> = {};
                  const allDirs: Directive[] = [...(directives.get() || [])].filter((d: Directive) => d && d.id && d.noteUrl);
                  for (const d of allDirs) {
                    const m = d.text.match(/^Re:\s*(.+?)\s*—/);
                    if (m) projectNotes[m[1]] = d.noteUrl;
                  }

                  // Build set of project names that have completed directive responses
                  const allDirectives = [...(directives.get() || [])] as Directive[];
                  const projectsWithResponses = new Set<string>();
                  for (const d of allDirectives) {
                    if (!d || d.status !== "done" || !d.response) continue;
                    const dm = d.text.match(/^Re:\s*(.+?)\s*\u2014/);
                    if (dm) projectsWithResponses.add(dm[1]);
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

                  // Determine which items to show at current breadcrumb depth
                  let visibleItems: { type: string, id: string, name: string, project: Project | null, idx: number, hasChildren: boolean }[] = [];

                  if (crumbs.length === 0) {
                    // Root level: show people who own projects + top-level projects
                    for (const parentId of Object.keys(visibleChildrenOf)) {
                      if (parentId.startsWith("PPL:")) {
                        const person = peopleItems.find((pp: Person) => pp.id === parentId);
                        const name = person ? person.name : parentId.split(":")[1];
                        visibleItems.push({ type: "person", id: parentId, name, project: null, idx: -1, hasChildren: true });
                      }
                    }
                    for (const p of projectItems) {
                      if (!p.parentId) {
                        if (hideCompleted && isCompleted(p.status)) continue;
                        const idx = projectItems.indexOf(p);
                        const hasKids = (visibleChildrenOf[p.id] || []).length > 0 || projectsWithResponses.has(p.name);
                        visibleItems.push({ type: "project", id: p.id, name: p.name, project: p, idx, hasChildren: hasKids });
                      }
                    }
                  } else {
                    // Drilled into a node — show its children
                    const currentId = crumbs[crumbs.length - 1].id;
                    const currentProject = projectItems.find((p: Project) => p.id === currentId);
                    const children = childrenOf[currentId] || [];
                    for (const child of children) {
                      if (hideCompleted && isCompleted(child.status)) continue;
                      const idx = projectItems.indexOf(child);
                      const hasKids = (visibleChildrenOf[child.id] || []).length > 0 || projectsWithResponses.has(child.name);
                      visibleItems.push({ type: "project", id: child.id, name: child.name, project: child, idx, hasChildren: hasKids });
                    }

                    // Add completed directive responses as sub-items
                    if (currentProject) {
                      for (const d of allDirectives) {
                        if (!d || d.status !== "done" || !d.response) continue;
                        const dm = d.text.match(/^Re:\s*(.+?)\s*\u2014/);
                        if (dm && dm[1] === currentProject.name) {
                          visibleItems.push({ type: "response", id: d.id, name: d.text, project: null, idx: -1, hasChildren: false });
                        }
                      }
                    }
                  }

                  return visibleItems.map((item: { type: string, id: string, name: string, project: Project | null, idx: number, hasChildren: boolean }) => {
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

                    // Directive response row
                    if (item.type === "response") {
                      const dir = allDirectives.find((dd: Directive) => dd.id === item.id);
                      if (!dir) return <div />;
                      const qMatch = dir.text.match(/^Re:\s*.+?\s*\u2014\s*(.+)$/);
                      const question = qMatch ? qMatch[1] : dir.text;
                      const dateStr = dir.createdAt
                        ? new Date(dir.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                        : "";
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
                                {dir.noteUrl ? (
                                  <a href={dir.noteUrl} target="_blank" style={{
                                    fontSize: "11px", color: color.blue, textDecoration: "none",
                                  }}>{"📎 View note"}</a>
                                ) : null}
                              </div>
                            </div>
                          </div>
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
                            selectedItem.get() === "projects:" + idx
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
                          {/* Item content — click to select */}
                          <div
                            style={{ display: "flex", alignItems: "center", gap: "10px", flex: "1", cursor: "pointer" }}
                            onClick={() => selectItem.send({ key: "projects:" + idx })}
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
                          {/* Drill-in chevron — separate click target */}
                          {item.hasChildren ? (
                            <div
                              style={{ padding: "4px 0 4px 8px", cursor: "pointer", flexShrink: "0" }}
                              onClick={() => drillIntoProject.send({ id: item.id, name: p.name })}
                            >
                              <span style={{ fontSize: "14px", color: color.tertiaryLabel }}>{">"}</span>
                            </div>
                          ) : null}
                        </div>
                        {ifElse(
                          computed(
                            () => selectedItem.get() === "projects:" + idx,
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
                              computed(() => itemDirectiveOpen.get()),
                              <div style={directiveInputRowStyle}>
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
                  });
                })}
              </div>,
              null,
            )}

            {/* People Panel */}
            {ifElse(
              computed(() => expandedPanel.get() === "people"),
              <div style={panelCardStyle}>
                <div style={groupHeaderStyle}>People</div>
                {computed(() => {
                  const peopleItems = displayPeople;
                  if (peopleItems.length === 0) {
                    return (
                      <div
                        style={{
                          fontSize: "13px",
                          color: color.tertiaryLabel,
                          padding: "12px 0",
                        }}
                      >
                        No people
                      </div>
                    );
                  }
                  return peopleItems.map((p: Person, idx: number) => (
                    <div>
                      <div
                        style={computed(() =>
                          selectedItem.get() === "people:" + idx
                            ? {
                                ...itemRowStyle,
                                display: "flex",
                                alignItems: "center",
                                gap: "10px",
                                cursor: "pointer",
                                background: "rgba(0, 122, 255, 0.06)",
                                borderRadius: "8px",
                                padding: "8px",
                              }
                            : {
                                ...itemRowStyle,
                                display: "flex",
                                alignItems: "center",
                                gap: "10px",
                                cursor: "pointer",
                              },
                        )}
                        onClick={() =>
                          selectItem.send({ key: "people:" + idx })
                        }
                      >
                        <span
                          style={{
                            fontWeight: "600",
                            flex: "1",
                          }}
                        >
                          {p.name}
                        </span>
                        <span
                          style={{
                            fontSize: "12px",
                            color: color.secondaryLabel,
                            fontWeight: "400",
                          }}
                        >
                          {p.role}
                        </span>
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
                      {ifElse(
                        computed(
                          () => selectedItem.get() === "people:" + idx,
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
                            <div
                              style={actionBtnDelete}
                              onClick={() =>
                                deleteItem.send({ key: "people:" + idx })
                              }
                            >
                              ✕ Delete
                            </div>
                          </div>
                          {ifElse(
                            computed(() => itemDirectiveOpen.get()),
                            <div style={directiveInputRowStyle}>
                              <ct-textarea
                                $value={itemDirectiveDraft}
                                placeholder="Directive about this person..."
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
                  ));
                })}
              </div>,
              null,
            )}

            {/* Waiting Panel */}
            {ifElse(
              computed(() => expandedPanel.get() === "waiting"),
              <div style={panelCardStyle}>
                <div style={{ ...groupHeaderStyle, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span>Waiting For</span>
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
                </div>
                {computed(() => {
                  const rawWaiting = displayWaiting;
                  // Filter out waiting items belonging to Done/Archived projects if showCompleted is off
                  const projectItems: Project[] = items.get()?.projects || [];
                  const completedProjectIds = new Set(
                    showCompleted.get() ? [] : projectItems.filter((p: Project) => p.status === "Done" || p.status === "Archived").map((p: Project) => p.id)
                  );
                  const waitingItems = completedProjectIds.size > 0
                    ? rawWaiting.filter((w: WaitingItem) => !w.projectId || !completedProjectIds.has(w.projectId))
                    : rawWaiting;
                  if (waitingItems.length === 0) {
                    return (
                      <div
                        style={{
                          fontSize: "13px",
                          color: color.tertiaryLabel,
                          padding: "12px 0",
                        }}
                      >
                        Nothing waiting
                      </div>
                    );
                  }
                  return waitingItems.map((w: WaitingItem, idx: number) => (
                    <div>
                      <div
                        style={computed(() =>
                          selectedItem.get() === "waiting:" + idx
                            ? {
                                ...itemRowStyle,
                                cursor: "pointer",
                                background: "rgba(0, 122, 255, 0.06)",
                                borderRadius: "8px",
                                padding: "8px",
                              }
                            : { ...itemRowStyle, cursor: "pointer" },
                        )}
                        onClick={() =>
                          selectItem.send({ key: "waiting:" + idx })
                        }
                      >
                        <span
                          style={{ fontWeight: "500", color: color.blue }}
                        >
                          {w.entity}
                        </span>
                        {w.description ? (
                          <span style={{ color: color.secondaryLabel }}>
                            {" — "}
                            {w.description}
                          </span>
                        ) : null}
                        {w.projectId ? (
                          <span
                            style={{
                              padding: "1px 6px",
                              borderRadius: "100px",
                              fontSize: "10px",
                              fontWeight: "500",
                              background: "rgba(0, 122, 255, 0.08)",
                              color: color.blue,
                              marginLeft: "6px",
                              flexShrink: "0",
                            }}
                          >
                            {w.projectId}
                          </span>
                        ) : null}
                      </div>
                      {ifElse(
                        computed(
                          () => selectedItem.get() === "waiting:" + idx,
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
                              style={actionBtnDone}
                              onClick={() =>
                                markItemDone.send({ key: "waiting:" + idx })
                              }
                            >
                              ✓ Done
                            </div>
                            <div
                              style={actionBtnDelete}
                              onClick={() =>
                                deleteItem.send({ key: "waiting:" + idx })
                              }
                            >
                              ✕ Delete
                            </div>
                            <div
                              style={actionBtnDirective}
                              onClick={openItemDirective}
                            >
                              → Directive
                            </div>
                          </div>
                          {ifElse(
                            computed(() => itemDirectiveOpen.get()),
                            <div style={directiveInputRowStyle}>
                              <ct-textarea
                                $value={itemDirectiveDraft}
                                placeholder="Directive about this item..."
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
                  ));
                })}
              </div>,
              null,
            )}

            {/* Actions Panel */}
            {ifElse(
              computed(() => expandedPanel.get() === "actions"),
              <div style={panelCardStyle}>
                <div style={{ ...groupHeaderStyle, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span>Next Actions</span>
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
                </div>
                {computed(() => {
                  const rawAll = displayActions;
                  // Filter out actions belonging to Done/Archived projects if showCompleted is off
                  const projectItems: Project[] = items.get()?.projects || [];
                  const completedProjectIds = new Set(
                    showCompleted.get() ? [] : projectItems.filter((p: Project) => p.status === "Done" || p.status === "Archived").map((p: Project) => p.id)
                  );
                  const all = completedProjectIds.size > 0
                    ? rawAll.filter((a: NextAction) => !a.projectId || !completedProjectIds.has(a.projectId))
                    : rawAll;
                  if (all.length === 0) {
                    return (
                      <div
                        style={{
                          fontSize: "13px",
                          color: color.tertiaryLabel,
                          padding: "12px 0",
                        }}
                      >
                        No next actions
                      </div>
                    );
                  }
                  // Group by context, preserving original indices
                  const groups: Record<
                    string,
                    { a: NextAction; origIdx: number }[]
                  > = {};
                  for (let i = 0; i < all.length; i++) {
                    const a = all[i];
                    if (!groups[a.context]) groups[a.context] = [];
                    groups[a.context].push({ a, origIdx: i });
                  }
                  const contexts = Object.keys(groups).sort();
                  return contexts.map((ctx: string) => {
                    const ctxActions = groups[ctx];
                    return (
                      <div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            padding: "10px 0 4px",
                            cursor: "pointer",
                          }}
                          onClick={() => toggleContext.send({ ctx })}
                        >
                          <span
                            style={computed(() => ({
                              fontSize: "10px",
                              color: color.tertiaryLabel,
                              transition: "transform 0.2s ease",
                              transform:
                                expandedContext.get() === ctx
                                  ? "rotate(90deg)"
                                  : "rotate(0deg)",
                            }))}
                          >
                            ▶
                          </span>
                          <span
                            style={{
                              fontSize: "13px",
                              fontWeight: "600",
                              color: color.blue,
                            }}
                          >
                            {ctx}
                          </span>
                          <span
                            style={{
                              fontSize: "12px",
                              color: color.tertiaryLabel,
                              marginLeft: "4px",
                            }}
                          >
                            ({ctxActions.length})
                          </span>
                        </div>
                        {ifElse(
                          computed(() => expandedContext.get() === ctx),
                          <div style={{ paddingLeft: "16px" }}>
                            {ctxActions.map(
                              ({
                                a,
                                origIdx,
                              }: {
                                a: NextAction;
                                origIdx: number;
                              }) => (
                                <div>
                                  <div
                                    style={computed(() =>
                                      selectedItem.get() ===
                                      "actions:" + origIdx
                                        ? {
                                            ...itemRowStyle,
                                            cursor: "pointer",
                                            background:
                                              "rgba(0, 122, 255, 0.06)",
                                            borderRadius: "8px",
                                            padding: "8px",
                                          }
                                        : {
                                            ...itemRowStyle,
                                            cursor: "pointer",
                                          },
                                    )}
                                    onClick={() =>
                                      selectItem.send({
                                        key: "actions:" + origIdx,
                                      })
                                    }
                                  >
                                    {a.section ? (
                                      <span
                                        style={{
                                          fontSize: "11px",
                                          color: color.tertiaryLabel,
                                          marginRight: "6px",
                                        }}
                                      >
                                        [{a.section}]
                                      </span>
                                    ) : null}
                                    <span>{a.text}</span>
                                    {a.projectId ? (
                                      <span
                                        style={{
                                          padding: "1px 6px",
                                          borderRadius: "100px",
                                          fontSize: "10px",
                                          fontWeight: "500",
                                          background: "rgba(0, 122, 255, 0.08)",
                                          color: color.blue,
                                          marginLeft: "6px",
                                          flexShrink: "0",
                                        }}
                                      >
                                        {a.projectId}
                                      </span>
                                    ) : null}
                                  </div>
                                  {ifElse(
                                    computed(
                                      () =>
                                        selectedItem.get() ===
                                        "actions:" + origIdx,
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
                                          style={actionBtnDone}
                                          onClick={() =>
                                            markItemDone.send({
                                              key: "actions:" + origIdx,
                                            })
                                          }
                                        >
                                          ✓ Done
                                        </div>
                                        <div
                                          style={actionBtnDelete}
                                          onClick={() =>
                                            deleteItem.send({
                                              key: "actions:" + origIdx,
                                            })
                                          }
                                        >
                                          ✕ Delete
                                        </div>
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
                                        <div style={directiveInputRowStyle}>
                                          <ct-textarea
                                            $value={itemDirectiveDraft}
                                            placeholder="Directive about this action..."
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
                              ),
                            )}
                          </div>,
                          null,
                        )}
                      </div>
                    );
                  });
                })}
              </div>,
              null,
            )}
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

                  {ifElse(
                    computed(
                      () =>
                        item.context !== undefined && item.context !== "",
                    ),
                    <div
                      style={{
                        fontSize: "13px",
                        lineHeight: "1.45",
                        color: color.secondaryLabel,
                        marginBottom: "12px",
                      }}
                    >
                      {item.context}
                    </div>,
                    null,
                  )}

                  {/* Pending actions */}
                  {ifElse(
                    computed(() => item.status === "pending"),
                    <div>
                      {ifElse(
                        computed(
                          () =>
                            item.options !== undefined &&
                            item.options.length > 0,
                        ),
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap" as const,
                            gap: "6px",
                            marginBottom: "10px",
                          }}
                        >
                          {computed(() =>
                            item.options.map((opt: string) => (
                              <div
                                style={{
                                  padding: "6px 14px",
                                  borderRadius: "100px",
                                  fontSize: "13px",
                                  fontWeight: "500",
                                  background: `rgba(0, 122, 255, 0.1)`,
                                  color: color.blue,
                                  cursor: "pointer",
                                }}
                                onClick={() =>
                                  answerQuestion.send({
                                    id: item.id,
                                    answer: opt,
                                    author: "human-lead",
                                  })
                                }
                              >
                                {opt}
                              </div>
                            )),
                          )}
                        </div>,
                        null,
                      )}

                      <div style={{ display: "flex", gap: "8px" }}>
                        <div
                          style={{
                            padding: "7px 16px",
                            borderRadius: "100px",
                            fontSize: "13px",
                            fontWeight: "600",
                            background: color.blue,
                            color: "#fff",
                            cursor: "pointer",
                          }}
                          onClick={() =>
                            selectQuestion.send({ id: item.id })
                          }
                        >
                          Reply
                        </div>
                        <div
                          style={{
                            padding: "7px 16px",
                            borderRadius: "100px",
                            fontSize: "13px",
                            fontWeight: "500",
                            color: color.secondaryLabel,
                            cursor: "pointer",
                          }}
                          onClick={() =>
                            dismissQuestion.send({ id: item.id })
                          }
                        >
                          Dismiss
                        </div>
                      </div>
                    </div>,
                    null,
                  )}

                  {/* Answered state */}
                  {ifElse(
                    computed(() => item.status === "answered"),
                    <div>
                      <div
                        style={{
                          padding: "10px 12px",
                          background: color.fillTertiary,
                          borderRadius: "10px",
                          marginBottom: "6px",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: "4px",
                          }}
                        >
                          <span
                            style={{
                              fontSize: "12px",
                              fontWeight: "600",
                              color: color.blue,
                            }}
                          >
                            {item.answeredBy}
                          </span>
                          <span
                            style={{
                              fontSize: "11px",
                              color: color.tertiaryLabel,
                            }}
                          >
                            {item.answeredAt}
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: "14px",
                            lineHeight: "1.45",
                            color: color.label,
                          }}
                        >
                          {item.answer}
                        </div>
                      </div>

                      {ifElse(
                        computed(
                          () =>
                            item.replies !== undefined &&
                            item.replies.length > 0,
                        ),
                        <div
                          style={{
                            borderLeft: `2px solid ${color.separator}`,
                            marginLeft: "12px",
                            paddingLeft: "12px",
                          }}
                        >
                          {computed(() =>
                            item.replies.map((reply: Reply) => (
                              <div
                                style={{
                                  padding: "8px 10px",
                                  background: color.fillTertiary,
                                  borderRadius: "8px",
                                  marginBottom: "4px",
                                }}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    marginBottom: "2px",
                                  }}
                                >
                                  <span
                                    style={{
                                      fontSize: "12px",
                                      fontWeight: "600",
                                      color: reply.author === "human-lead"
                                        ? color.green
                                        : color.blue,
                                    }}
                                  >
                                    {reply.author}
                                  </span>
                                  <span
                                    style={{
                                      fontSize: "10px",
                                      color: color.tertiaryLabel,
                                    }}
                                  >
                                    {reply.at}
                                  </span>
                                </div>
                                <div
                                  style={{
                                    fontSize: "13px",
                                    lineHeight: "1.4",
                                    color: color.label,
                                  }}
                                >
                                  {reply.text}
                                </div>
                              </div>
                            )),
                          )}
                        </div>,
                        null,
                      )}

                      <div
                        style={{
                          display: "flex",
                          gap: "8px",
                          marginTop: "8px",
                        }}
                      >
                        <div
                          style={{
                            padding: "5px 14px",
                            borderRadius: "100px",
                            fontSize: "12px",
                            fontWeight: "500",
                            color: color.blue,
                            cursor: "pointer",
                            background: `rgba(0, 122, 255, 0.08)`,
                          }}
                          onClick={() =>
                            reopenQuestion.send({ id: item.id })
                          }
                        >
                          Add Reply
                        </div>
                      </div>
                    </div>,
                    null,
                  )}
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
                style={{
                  borderRadius: "10px",
                  marginBottom: "10px",
                }}
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
