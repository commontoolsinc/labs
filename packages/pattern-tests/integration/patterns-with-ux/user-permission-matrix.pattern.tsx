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

interface PermissionDefinitionInput {
  id?: string;
  label?: string;
}

interface RolePermissionInput {
  id?: string;
  label?: string;
  grants?: string[];
}

interface PermissionDefinition {
  id: string;
  label: string;
}

interface RoleDefinition {
  id: string;
  label: string;
  grants: string[];
}

interface TogglePermissionEvent {
  role?: string;
  permission?: string;
  grant?: boolean;
}

interface RoleSummary {
  id: string;
  label: string;
  granted: string[];
  missing: string[];
  enabledCount: number;
  disabledCount: number;
  summary: string;
}

interface PermissionMatrixRow {
  label: string;
  grants: Record<string, boolean>;
}

type PermissionMatrixView = Record<string, PermissionMatrixRow>;

interface UserPermissionMatrixArgs {
  permissions: Default<
    PermissionDefinitionInput[],
    typeof defaultPermissions
  >;
  roles: Default<RolePermissionInput[], typeof defaultRoles>;
}

const defaultPermissions: PermissionDefinition[] = [
  { id: "manageUsers", label: "Manage Users" },
  { id: "editContent", label: "Edit Content" },
  { id: "viewReports", label: "View Reports" },
  { id: "publishContent", label: "Publish Content" },
];

const defaultRoles: RoleDefinition[] = [
  {
    id: "admin",
    label: "Administrator",
    grants: [
      "manageUsers",
      "editContent",
      "viewReports",
      "publishContent",
    ],
  },
  {
    id: "editor",
    label: "Editor",
    grants: [
      "editContent",
      "viewReports",
      "publishContent",
    ],
  },
  {
    id: "viewer",
    label: "Viewer",
    grants: ["viewReports"],
  },
];

const sanitizeLabel = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

const sanitizeKey = (value: unknown, fallback: string): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      if (/^[A-Za-z][A-Za-z0-9]*$/.test(trimmed)) {
        return trimmed;
      }
      const segments = trimmed
        .replace(/[^a-zA-Z0-9]+/g, " ")
        .trim()
        .split(/\s+/);
      if (segments.length > 0) {
        const [first, ...rest] = segments;
        const normalized = first.toLowerCase() +
          rest
            .map((segment) => {
              const lower = segment.toLowerCase();
              return lower.charAt(0).toUpperCase() + lower.slice(1);
            })
            .join("");
        const sanitized = normalized.replace(/[^a-zA-Z0-9]/g, "");
        if (sanitized.length > 0) {
          return sanitized;
        }
      }
    }
  }
  if (typeof fallback === "string" && fallback.length > 0) {
    return fallback;
  }
  return null;
};

const ensureUniqueKey = (value: string, used: Set<string>): string => {
  let candidate = value;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${value}${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
};

const sanitizePermissionList = (
  value: unknown,
): PermissionDefinition[] => {
  const source = Array.isArray(value) ? value : defaultPermissions;
  const sanitized: PermissionDefinition[] = [];
  const used = new Set<string>();
  for (let index = 0; index < source.length; index++) {
    const entry = source[index] as PermissionDefinitionInput | undefined;
    const fallback = defaultPermissions[index] ?? defaultPermissions[0];
    const fallbackLabel = sanitizeLabel(
      fallback?.label ?? fallback?.id ?? `Permission ${index + 1}`,
      `Permission ${index + 1}`,
    );
    const keySource = entry?.id ?? entry?.label ?? fallback.id;
    const key = sanitizeKey(keySource, fallback.id);
    if (!key) continue;
    const id = ensureUniqueKey(key, used);
    const label = sanitizeLabel(entry?.label, fallbackLabel);
    sanitized.push({ id, label });
  }
  if (sanitized.length === 0) {
    return defaultPermissions.map((entry) => ({ ...entry }));
  }
  return sanitized;
};

const sanitizeRoleList = (
  value: unknown,
  permissions: readonly PermissionDefinition[],
): RoleDefinition[] => {
  const source = Array.isArray(value) ? value : defaultRoles;
  const sanitized: RoleDefinition[] = [];
  const used = new Set<string>();
  const available = new Set(permissions.map((entry) => entry.id));
  const labels = new Map(
    permissions.map((entry) => [entry.label.toLowerCase(), entry.id]),
  );
  for (let index = 0; index < source.length; index++) {
    const entry = source[index] as RolePermissionInput | undefined;
    const fallback = defaultRoles[index] ?? defaultRoles[0];
    const label = sanitizeLabel(entry?.label, fallback.label);
    const keySource = entry?.id ?? entry?.label ?? fallback.id;
    const key = sanitizeKey(keySource, fallback.id);
    if (!key) continue;
    const id = ensureUniqueKey(key, used);
    const grantSource = Array.isArray(entry?.grants) && entry?.grants.length > 0
      ? entry?.grants
      : fallback.grants;
    const grantSet = new Set<string>();
    for (const raw of grantSource) {
      if (typeof raw !== "string") continue;
      const normalized = sanitizeKey(raw, "");
      if (normalized && available.has(normalized)) {
        grantSet.add(normalized);
        continue;
      }
      const lower = raw.trim().toLowerCase();
      const byLabel = labels.get(lower);
      if (byLabel) {
        grantSet.add(byLabel);
      }
    }
    const grants = permissions
      .map((entry) => entry.id)
      .filter((permissionId) => grantSet.has(permissionId));
    sanitized.push({ id, label, grants });
  }
  if (sanitized.length === 0) {
    return defaultRoles.map((entry) => ({
      id: entry.id,
      label: entry.label,
      grants: permissions
        .map((perm) => perm.id)
        .filter((perm) => entry.grants.includes(perm)),
    }));
  }
  return sanitized;
};

const cloneRoleList = (
  entries: readonly RoleDefinition[],
): RoleDefinition[] => {
  return entries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    grants: [...entry.grants],
  }));
};

const resolveRoleId = (
  roles: readonly RoleDefinition[],
  value: unknown,
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const direct = roles.find((role) => role.id === trimmed);
  if (direct) return direct.id;
  const normalized = sanitizeKey(trimmed, "");
  if (normalized) {
    const byKey = roles.find((role) => role.id === normalized);
    if (byKey) return byKey.id;
  }
  const lower = trimmed.toLowerCase();
  const byLabel = roles.find((role) => role.label.toLowerCase() === lower);
  return byLabel?.id ?? null;
};

const resolvePermissionId = (
  permissions: readonly PermissionDefinition[],
  value: unknown,
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const direct = permissions.find((permission) => permission.id === trimmed);
  if (direct) return direct.id;
  const normalized = sanitizeKey(trimmed, "");
  if (normalized) {
    const byKey = permissions.find((permission) =>
      permission.id === normalized
    );
    if (byKey) return byKey.id;
  }
  const lower = trimmed.toLowerCase();
  const byLabel = permissions.find((permission) =>
    permission.label.toLowerCase() === lower
  );
  return byLabel?.id ?? null;
};

const matrixFromRoles = (
  roles: readonly RoleDefinition[],
  permissions: readonly PermissionDefinition[],
): PermissionMatrixView => {
  const matrix: PermissionMatrixView = {};
  for (const role of roles) {
    const grants: Record<string, boolean> = {};
    for (const permission of permissions) {
      grants[permission.id] = role.grants.includes(permission.id);
    }
    matrix[role.id] = { label: role.label, grants };
  }
  return matrix;
};

const computeRoleSummaries = (
  roles: readonly RoleDefinition[],
  permissions: readonly PermissionDefinition[],
): RoleSummary[] => {
  const order = permissions.map((entry) => entry.id);
  const total = order.length;
  return roles.map((role) => {
    const granted = order.filter((id) => role.grants.includes(id));
    const missing = order.filter((id) => !granted.includes(id));
    const enabledCount = granted.length;
    const disabledCount = total - enabledCount;
    const summary = `${role.label}: ${enabledCount}/${
      Math.max(total, 1)
    } permissions`;
    return {
      id: role.id,
      label: role.label,
      granted,
      missing,
      enabledCount,
      disabledCount,
      summary,
    };
  });
};

const toggleRolePermission = handler(
  (
    event: TogglePermissionEvent | undefined,
    context: {
      assignments: Cell<RoleDefinition[]>;
      baseRoles: Cell<RoleDefinition[]>;
      permissions: Cell<PermissionDefinition[]>;
      history: Cell<string[]>;
    },
  ) => {
    const permissions = context.permissions.get() ?? [];
    if (permissions.length === 0) {
      return;
    }
    const stored = context.assignments.get();
    const base = context.baseRoles.get();
    const current = Array.isArray(stored) && stored.length > 0
      ? cloneRoleList(stored)
      : Array.isArray(base)
      ? cloneRoleList(base)
      : [];
    if (current.length === 0) {
      return;
    }
    const roleId = resolveRoleId(current, event?.role);
    const permissionId = resolvePermissionId(permissions, event?.permission);
    if (!roleId || !permissionId) {
      return;
    }
    const index = current.findIndex((entry) => entry.id === roleId);
    if (index === -1) {
      return;
    }
    const role = current[index];
    const grantSet = new Set(role.grants);
    const desired = typeof event?.grant === "boolean"
      ? event.grant
      : !grantSet.has(permissionId);
    const alreadyGranted = grantSet.has(permissionId);
    if (desired && alreadyGranted) {
      return;
    }
    if (!desired && !alreadyGranted) {
      return;
    }
    if (desired) {
      grantSet.add(permissionId);
    } else {
      grantSet.delete(permissionId);
    }
    const ordered = permissions.map((permission) => permission.id);
    current[index] = {
      id: role.id,
      label: role.label,
      grants: ordered.filter((id) => grantSet.has(id)),
    };
    context.assignments.set(cloneRoleList(current));
    const permission = permissions.find((entry) => entry.id === permissionId);
    const action = desired ? "Granted" : "Revoked";
    const message = `${action} ${
      permission?.label ?? permissionId
    } for ${role.label}`;
    const existing = context.history.get();
    const history = Array.isArray(existing)
      ? [...existing, message]
      : [message];
    context.history.set(history);
  },
);

export const userPermissionMatrixUx = recipe<UserPermissionMatrixArgs>(
  "User Permission Matrix (UX)",
  ({ permissions, roles }) => {
    const permissionsList = lift(sanitizePermissionList)(permissions);
    const baseRoles = lift((input: {
      entries: RolePermissionInput[] | undefined;
      permissionList: PermissionDefinition[];
    }) => sanitizeRoleList(input.entries, input.permissionList))({
      entries: roles,
      permissionList: permissionsList,
    });

    const assignmentStore = cell<RoleDefinition[]>([]);
    const changeHistory = cell<string[]>([]);

    const activeRoles = lift((input: {
      stored: RoleDefinition[];
      base: RoleDefinition[];
    }) => {
      const stored = Array.isArray(input.stored) ? input.stored : [];
      if (stored.length > 0) {
        return cloneRoleList(stored);
      }
      return cloneRoleList(input.base);
    })({
      stored: assignmentStore,
      base: baseRoles,
    });

    const matrix = lift((input: {
      roleList: RoleDefinition[];
      permissionList: PermissionDefinition[];
    }) => matrixFromRoles(input.roleList, input.permissionList))({
      roleList: activeRoles,
      permissionList: permissionsList,
    });

    const summaries = lift((input: {
      roleList: RoleDefinition[];
      permissionList: PermissionDefinition[];
    }) => computeRoleSummaries(input.roleList, input.permissionList))({
      roleList: activeRoles,
      permissionList: permissionsList,
    });

    const summaryLabels = lift((entries: RoleSummary[]) =>
      entries.map((entry) => entry.summary)
    )(summaries);

    const totalEnabled = lift((entries: RoleSummary[]) =>
      entries.reduce((total, entry) => total + entry.enabledCount, 0)
    )(summaries);

    const totalRoles = lift((entries: RoleDefinition[]) => entries.length)(
      activeRoles,
    );

    const totalPermissions = lift((entries: PermissionDefinition[]) =>
      entries.length
    )(permissionsList);

    const status =
      str`${totalEnabled} grants across ${totalRoles} roles and ${totalPermissions} permissions`;

    const historyView = lift((entries: string[] | undefined) =>
      Array.isArray(entries) ? entries : []
    )(changeHistory);

    const lastChange = lift((entries: string[] | undefined) => {
      if (Array.isArray(entries) && entries.length > 0) {
        return entries[entries.length - 1];
      }
      return "No changes yet";
    })(changeHistory);

    const togglePermission = toggleRolePermission({
      assignments: assignmentStore,
      baseRoles,
      permissions: permissionsList,
      history: changeHistory,
    });

    // UI form fields
    const roleField = cell<string>("");
    const permissionField = cell<string>("");

    const uiToggleGrant = handler(
      (_event, context: {
        roleField: Cell<string>;
        permissionField: Cell<string>;
        assignments: Cell<RoleDefinition[]>;
        baseRoles: Cell<RoleDefinition[]>;
        permissions: Cell<PermissionDefinition[]>;
        history: Cell<string[]>;
      }) => {
        const roleInput = context.roleField.get();
        const permissionInput = context.permissionField.get();

        if (
          typeof roleInput !== "string" || roleInput.trim() === "" ||
          typeof permissionInput !== "string" || permissionInput.trim() === ""
        ) {
          return;
        }

        const permissions = context.permissions.get() ?? [];
        if (permissions.length === 0) {
          return;
        }
        const stored = context.assignments.get();
        const base = context.baseRoles.get();
        const current = Array.isArray(stored) && stored.length > 0
          ? cloneRoleList(stored)
          : Array.isArray(base)
          ? cloneRoleList(base)
          : [];
        if (current.length === 0) {
          return;
        }
        const roleId = resolveRoleId(current, roleInput);
        const permissionId = resolvePermissionId(permissions, permissionInput);
        if (!roleId || !permissionId) {
          return;
        }
        const index = current.findIndex((entry) => entry.id === roleId);
        if (index === -1) {
          return;
        }
        const role = current[index];
        const grantSet = new Set(role.grants);
        const desired = !grantSet.has(permissionId);
        const alreadyGranted = grantSet.has(permissionId);
        if (desired && alreadyGranted) {
          return;
        }
        if (!desired && !alreadyGranted) {
          return;
        }
        if (desired) {
          grantSet.add(permissionId);
        } else {
          grantSet.delete(permissionId);
        }
        const ordered = permissions.map((permission) => permission.id);
        current[index] = {
          id: role.id,
          label: role.label,
          grants: ordered.filter((id) => grantSet.has(id)),
        };
        context.assignments.set(cloneRoleList(current));
        const permission = permissions.find((entry) =>
          entry.id === permissionId
        );
        const action = desired ? "Granted" : "Revoked";
        const message = `${action} ${
          permission?.label ?? permissionId
        } for ${role.label}`;
        const existing = context.history.get();
        const history = Array.isArray(existing)
          ? [...existing, message]
          : [message];
        context.history.set(history);

        context.roleField.set("");
        context.permissionField.set("");
      },
    )({
      roleField,
      permissionField,
      assignments: assignmentStore,
      baseRoles,
      permissions: permissionsList,
      history: changeHistory,
    });

    const name = str`Permission Matrix`;

    const ui = (
      <div style="font-family: system-ui, sans-serif; max-width: 1200px; margin: 0 auto; padding: 24px;">
        <div style="margin-bottom: 24px;">
          <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 600; color: #1f2937;">
            Permission Matrix
          </h1>
          <p style="margin: 0; font-size: 14px; color: #6b7280;">{status}</p>
        </div>

        <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
          <h2 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #374151;">
            Toggle Permission
          </h2>
          <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 12px; align-items: end;">
            <div>
              <label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500; color: #374151;">
                Role ID or Name
              </label>
              <ct-input
                $value={roleField}
                placeholder="admin, editor, viewer..."
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500; color: #374151;">
                Permission ID or Name
              </label>
              <ct-input
                $value={permissionField}
                placeholder="manageUsers, editContent..."
                style="width: 100%;"
              />
            </div>
            <ct-button onClick={uiToggleGrant} style="padding: 8px 16px;">
              Toggle
            </ct-button>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 24px;">
          {lift((data: {
            roles: RoleDefinition[];
            permissions: PermissionDefinition[];
            matrixData: PermissionMatrixView;
          }) => {
            const roleElements = [];
            for (const role of data.roles) {
              const row = data.matrixData[role.id];
              if (!row) continue;
              const granted = [];
              const revoked = [];
              for (const permission of data.permissions) {
                if (row.grants[permission.id]) {
                  granted.push(permission.label);
                } else {
                  revoked.push(permission.label);
                }
              }
              const grantedCount = granted.length;
              const totalCount = data.permissions.length;
              const percentage = totalCount > 0
                ? String(Math.round((grantedCount / totalCount) * 100))
                : "0";
              const barWidth = percentage + "%";

              const cardStyle =
                "background: white; border: 2px solid #e5e7eb; border-radius: 8px; padding: 16px;";
              const headerStyle =
                "margin: 0 0 12px 0; font-size: 16px; font-weight: 600; color: #1f2937;";
              const countStyle =
                "font-size: 24px; font-weight: 700; color: #3b82f6; margin-bottom: 8px;";
              const progressBgStyle =
                "background: #e5e7eb; height: 8px; border-radius: 4px; overflow: hidden; margin-bottom: 12px;";
              const progressBarStyle =
                "background: linear-gradient(90deg, #3b82f6, #2563eb); height: 100%; width: " +
                barWidth + "; transition: width 0.3s ease;";
              const sectionStyle =
                "margin-top: 12px; padding-top: 12px; border-top: 1px solid #e5e7eb;";
              const labelStyle =
                "font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px;";
              const listStyle = "display: flex; flex-wrap: wrap; gap: 4px;";

              const grantedBadges = [];
              for (const label of granted) {
                const badgeStyle =
                  "display: inline-block; background: #dcfce7; color: #166534; border: 1px solid #86efac; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500;";
                grantedBadges.push(
                  h("span", { style: badgeStyle, key: label }, label),
                );
              }

              const revokedBadges = [];
              for (const label of revoked) {
                const badgeStyle =
                  "display: inline-block; background: #f3f4f6; color: #6b7280; border: 1px solid #d1d5db; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500;";
                revokedBadges.push(
                  h("span", { style: badgeStyle, key: label }, label),
                );
              }

              roleElements.push(
                h("div", { style: cardStyle, key: role.id }, [
                  h("h3", { style: headerStyle }, role.label),
                  h(
                    "div",
                    { style: countStyle },
                    String(grantedCount) + " / " + String(totalCount),
                  ),
                  h("div", { style: progressBgStyle }, [
                    h("div", { style: progressBarStyle }),
                  ]),
                  granted.length > 0
                    ? h("div", { style: sectionStyle }, [
                      h("div", { style: labelStyle }, "Granted"),
                      h("div", { style: listStyle }, ...grantedBadges),
                    ])
                    : null,
                  revoked.length > 0
                    ? h("div", { style: sectionStyle }, [
                      h("div", { style: labelStyle }, "Not Granted"),
                      h("div", { style: listStyle }, ...revokedBadges),
                    ])
                    : null,
                ]),
              );
            }
            return h("div", { style: "display: contents;" }, ...roleElements);
          })({
            roles: activeRoles,
            permissions: permissionsList,
            matrixData: matrix,
          })}
        </div>

        <div style="background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; padding: 16px;">
          <h2 style="margin: 0 0 12px 0; font-size: 16px; font-weight: 600; color: #92400e;">
            Recent Changes
          </h2>
          <div style="font-size: 14px; color: #78350f; font-weight: 500;">
            {lastChange}
          </div>
          {lift((history: string[]) => {
            if (!Array.isArray(history) || history.length === 0) {
              return null;
            }
            const reversed = history.slice().reverse();
            const recent = reversed.slice(0, 5);
            const entries = [];
            for (let i = 0; i < recent.length; i++) {
              const entry = recent[i];
              const entryStyle =
                "padding: 8px 0; font-size: 13px; color: #78350f;";
              const bulletStyle = "color: #f59e0b; margin-right: 8px;";
              entries.push(
                h("div", { style: entryStyle, key: i }, [
                  h("span", { style: bulletStyle }, "•"),
                  entry,
                ]),
              );
            }
            return h(
              "div",
              {
                style:
                  "margin-top: 12px; padding-top: 12px; border-top: 1px solid #fcd34d;",
              },
              ...entries,
            );
          })(historyView)}
        </div>

        <div style="margin-top: 24px; padding: 16px; background: #f3f4f6; border-radius: 8px;">
          <h3 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #4b5563;">
            Available Roles
          </h3>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            {lift((roles: RoleDefinition[]) => {
              const badges = [];
              for (const role of roles) {
                const badgeStyle =
                  "display: inline-block; background: #dbeafe; color: #1e40af; border: 1px solid #93c5fd; padding: 4px 12px; border-radius: 6px; font-size: 13px; font-weight: 500;";
                badges.push(
                  h("span", { style: badgeStyle, key: role.id }, [
                    h("strong", {}, role.id),
                    " (" + role.label + ")",
                  ]),
                );
              }
              return h("div", { style: "display: contents;" }, ...badges);
            })(activeRoles)}
          </div>
        </div>

        <div style="margin-top: 16px; padding: 16px; background: #f3f4f6; border-radius: 8px;">
          <h3 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #4b5563;">
            Available Permissions
          </h3>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            {lift((permissions: PermissionDefinition[]) => {
              const badges = [];
              for (const permission of permissions) {
                const badgeStyle =
                  "display: inline-block; background: #fef3c7; color: #92400e; border: 1px solid #fcd34d; padding: 4px 12px; border-radius: 6px; font-size: 13px; font-weight: 500;";
                badges.push(
                  h("span", { style: badgeStyle, key: permission.id }, [
                    h("strong", {}, permission.id),
                    " (" + permission.label + ")",
                  ]),
                );
              }
              return h("div", { style: "display: contents;" }, ...badges);
            })(permissionsList)}
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      permissions: permissionsList,
      roles: activeRoles,
      matrix,
      summaries,
      summaryLabels,
      totals: {
        enabled: totalEnabled,
        roles: totalRoles,
        permissions: totalPermissions,
      },
      status,
      history: historyView,
      lastChange,
      togglePermission,
    };
  },
);
