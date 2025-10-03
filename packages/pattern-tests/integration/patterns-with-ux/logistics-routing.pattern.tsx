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

interface RouteInput {
  id?: string;
  label?: string;
  capacity?: number;
}

interface RouteDefinition {
  id: string;
  label: string;
  capacity: number;
}

interface ShipmentInput {
  id?: string;
  route?: string;
  weight?: number;
}

interface ShipmentRecord {
  id: string;
  route: string;
  weight: number;
}

interface LogisticsRoutingArgs {
  routes: Default<RouteInput[], typeof defaultRoutes>;
  shipments: Default<ShipmentInput[], typeof defaultShipments>;
}

interface RouteLoadMetric {
  route: string;
  label: string;
  capacity: number;
  used: number;
  remaining: number;
  utilization: number;
  isOverCapacity: boolean;
}

interface AssignmentEvent {
  shipment?: string;
  targetRoute?: string;
}

const defaultRoutes: RouteDefinition[] = [
  { id: "NORTH", label: "North Loop", capacity: 18 },
  { id: "EAST", label: "East Express", capacity: 12 },
  { id: "SOUTH", label: "South Freight", capacity: 16 },
];

const defaultShipments: ShipmentRecord[] = [
  { id: "PKG-100", route: "NORTH", weight: 5 },
  { id: "PKG-101", route: "NORTH", weight: 4 },
  { id: "PKG-200", route: "EAST", weight: 3 },
  { id: "PKG-201", route: "EAST", weight: 2 },
  { id: "PKG-300", route: "SOUTH", weight: 5 },
  { id: "PKG-301", route: "SOUTH", weight: 6 },
];

const sanitizeLabel = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeRouteId = (value: unknown, fallback: string): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed.toUpperCase();
  }
  if (typeof fallback === "string" && fallback.length > 0) {
    return fallback.toUpperCase();
  }
  return null;
};

const sanitizeCapacity = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : fallback;
  }
  return fallback;
};

const ensureUniqueId = (value: string, used: Set<string>): string => {
  let candidate = value;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${value}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
};

const sanitizeRoutes = (value: unknown): RouteDefinition[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return structuredClone(defaultRoutes);
  }
  const used = new Set<string>();
  const sanitized: RouteDefinition[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] as RouteInput | undefined;
    const fallback = defaultRoutes[index] ?? defaultRoutes[0];
    const label = sanitizeLabel(entry?.label, fallback.label);
    const rawId = sanitizeRouteId(entry?.id ?? entry?.label, fallback.id);
    if (!rawId) continue;
    const id = ensureUniqueId(rawId, used);
    const capacity = sanitizeCapacity(entry?.capacity, fallback.capacity);
    sanitized.push({ id, label, capacity });
  }
  if (sanitized.length === 0) {
    return structuredClone(defaultRoutes);
  }
  return sanitized;
};

const sanitizeShipmentId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.toUpperCase();
};

const sanitizeWeight = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.round(Math.max(value, 0) * 100) / 100;
    return normalized > 0 ? normalized : fallback;
  }
  return fallback;
};

const resolveRouteId = (
  routes: readonly RouteDefinition[],
  value: unknown,
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const candidate = trimmed.toUpperCase();
  const byId = routes.find((route) => route.id === candidate);
  if (byId) return byId.id;
  const normalized = trimmed.toLowerCase();
  const byLabel = routes.find((route) =>
    route.label.toLowerCase() === normalized
  );
  return byLabel?.id ?? null;
};

const sanitizeShipments = (
  value: unknown,
  routes: readonly RouteDefinition[],
): ShipmentRecord[] => {
  const source = Array.isArray(value)
    ? value as ShipmentInput[]
    : defaultShipments;
  if (routes.length === 0) {
    return [];
  }
  const capacities = new Map<string, number>();
  const used = new Map<string, number>();
  for (const route of routes) {
    capacities.set(route.id, route.capacity);
    used.set(route.id, 0);
  }
  const sanitized: ShipmentRecord[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < source.length; index++) {
    const entry = source[index];
    const fallback = defaultShipments[index] ?? defaultShipments[0];
    const id = sanitizeShipmentId(entry?.id) ?? fallback.id;
    if (seen.has(id)) continue;
    const routeId = resolveRouteId(routes, entry?.route) ?? fallback.route;
    if (!capacities.has(routeId)) continue;
    const weight = sanitizeWeight(entry?.weight, fallback.weight);
    const current = used.get(routeId) ?? 0;
    const limit = capacities.get(routeId) ?? 0;
    if (current + weight > limit) continue;
    used.set(routeId, current + weight);
    sanitized.push({ id, route: routeId, weight });
    seen.add(id);
  }
  if (sanitized.length === 0) {
    const fallback: ShipmentRecord[] = [];
    const remaining = new Map(capacities);
    for (const entry of defaultShipments) {
      const id = entry.id;
      if (seen.has(id)) continue;
      for (const route of routes) {
        const limit = remaining.get(route.id) ?? 0;
        if (limit >= entry.weight) {
          remaining.set(route.id, limit - entry.weight);
          fallback.push({
            id,
            route: route.id,
            weight: entry.weight,
          });
          seen.add(id);
          break;
        }
      }
    }
    fallback.sort((left, right) => left.id.localeCompare(right.id));
    return fallback;
  }
  sanitized.sort((left, right) => left.id.localeCompare(right.id));
  return sanitized;
};

const roundRatio = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const computeLoadMetrics = (
  routes: readonly RouteDefinition[],
  shipments: readonly ShipmentRecord[],
): RouteLoadMetric[] => {
  const loads = new Map<string, number>();
  for (const route of routes) {
    loads.set(route.id, 0);
  }
  for (const shipment of shipments) {
    const current = loads.get(shipment.route) ?? 0;
    loads.set(shipment.route, current + shipment.weight);
  }
  return routes.map((route) => {
    const used = loads.get(route.id) ?? 0;
    const remaining = route.capacity - used;
    return {
      route: route.id,
      label: route.label,
      capacity: route.capacity,
      used,
      remaining: remaining > 0 ? roundRatio(remaining) : 0,
      utilization: route.capacity > 0 ? roundRatio(used / route.capacity) : 0,
      isOverCapacity: used > route.capacity,
    };
  });
};

const reassignShipment = handler(
  (
    event: AssignmentEvent | undefined,
    context: {
      shipments: Cell<ShipmentRecord[]>;
      baseShipments: Cell<ShipmentRecord[]>;
      routes: Cell<RouteDefinition[]>;
      history: Cell<string[]>;
      lastAction: Cell<string>;
      sequence: Cell<number>;
    },
  ) => {
    const routes = context.routes.get() ?? [];
    if (routes.length === 0) return;

    const shipmentId = sanitizeShipmentId(event?.shipment);
    const targetRoute = resolveRouteId(routes, event?.targetRoute);
    if (!shipmentId || !targetRoute) return;

    const stored = context.shipments.get();
    const base = context.baseShipments.get();
    const existing = Array.isArray(stored) && stored.length > 0
      ? stored.map((entry) => ({ ...entry }))
      : Array.isArray(base)
      ? base.map((entry) => ({ ...entry }))
      : [];

    const index = existing.findIndex((entry) => entry.id === shipmentId);
    if (index === -1) return;

    const record = existing[index];
    if (record.route === targetRoute) {
      return;
    }

    const capacityMap = new Map<string, number>();
    const usage = new Map<string, number>();
    for (const route of routes) {
      capacityMap.set(route.id, route.capacity);
      usage.set(route.id, 0);
    }
    for (let i = 0; i < existing.length; i++) {
      if (i === index) continue;
      const entry = existing[i];
      usage.set(entry.route, (usage.get(entry.route) ?? 0) + entry.weight);
    }
    const targetCapacity = capacityMap.get(targetRoute) ?? 0;
    const currentLoad = usage.get(targetRoute) ?? 0;
    if (currentLoad + record.weight > targetCapacity) {
      const message =
        `Blocked move of ${shipmentId} to ${targetRoute}; capacity ${targetCapacity}`;
      const log = context.history.get();
      context.history.set([...(Array.isArray(log) ? log : []), message]);
      context.lastAction.set(message);
      const sequence = (context.sequence.get() ?? 0) + 1;
      context.sequence.set(sequence);
      return;
    }

    const updated = existing.map((entry, position) => {
      if (position !== index) return { ...entry };
      return { id: entry.id, route: targetRoute, weight: entry.weight };
    });
    updated.sort((left, right) => left.id.localeCompare(right.id));
    context.shipments.set(updated);

    const message =
      `Moved ${shipmentId} from ${record.route} to ${targetRoute}`;
    const log = context.history.get();
    context.history.set([...(Array.isArray(log) ? log : []), message]);
    context.lastAction.set(message);
    const sequence = (context.sequence.get() ?? 0) + 1;
    context.sequence.set(sequence);
  },
);

export const logisticsRoutingUx = recipe<LogisticsRoutingArgs>(
  "Logistics Routing",
  ({ routes, shipments }) => {
    const routesList = lift(sanitizeRoutes)(routes);
    const baseShipments = lift((input: {
      entries: ShipmentInput[] | undefined;
      routeList: RouteDefinition[];
    }) => sanitizeShipments(input.entries, input.routeList))({
      entries: shipments,
      routeList: routesList,
    });

    const shipmentStore = cell<ShipmentRecord[]>([]);

    const assignmentList = lift((input: {
      stored: ShipmentRecord[];
      base: ShipmentRecord[];
    }) => {
      const stored = Array.isArray(input.stored) ? input.stored : [];
      if (stored.length > 0) {
        return stored.map((entry) => ({ ...entry }));
      }
      const base = Array.isArray(input.base) ? input.base : [];
      return base.map((entry) => ({ ...entry }));
    })({
      stored: shipmentStore,
      base: baseShipments,
    });

    const loadMetrics = lift((input: {
      routeList: RouteDefinition[];
      shipmentsList: ShipmentRecord[];
    }) => computeLoadMetrics(input.routeList, input.shipmentsList))({
      routeList: routesList,
      shipmentsList: assignmentList,
    });

    const availableRoutes = lift((entries: RouteLoadMetric[]) => {
      return entries
        .filter((entry) => entry.remaining > 0)
        .map((entry) => entry.route)
        .sort();
    })(loadMetrics);

    const overloaded = lift((entries: RouteLoadMetric[]) => {
      return entries
        .filter((entry) => entry.isOverCapacity)
        .map((entry) => entry.route)
        .sort();
    })(loadMetrics);

    const shipmentCount = lift((entries: ShipmentRecord[]) => entries.length)(
      assignmentList,
    );
    const routeCount = lift((entries: RouteDefinition[]) => entries.length)(
      routesList,
    );
    const overloadedCount = lift((entries: string[]) => entries.length)(
      overloaded,
    );

    const status =
      str`${shipmentCount} shipments across ${routeCount} routes; overloaded ${overloadedCount}`;

    const history = cell<string[]>([]);
    const lastAction = cell("initialized");
    const sequence = cell(0);

    const historyView = lift((entries: string[] | undefined) => {
      return Array.isArray(entries) ? [...entries] : [];
    })(history);
    const lastActionView = lift((value: string | undefined) => {
      return typeof value === "string" && value.length > 0
        ? value
        : "initialized";
    })(lastAction);

    const assignShipment = reassignShipment({
      shipments: shipmentStore,
      baseShipments,
      routes: routesList,
      history,
      lastAction,
      sequence,
    });

    // UI cells
    const shipmentIdField = cell<string>("");
    const targetRouteField = cell<string>("");

    const uiReassignHandler = handler<
      unknown,
      {
        shipmentIdField: Cell<string>;
        targetRouteField: Cell<string>;
        shipments: Cell<ShipmentRecord[]>;
        baseShipments: Cell<ShipmentRecord[]>;
        routes: Cell<RouteDefinition[]>;
        history: Cell<string[]>;
        lastAction: Cell<string>;
        sequence: Cell<number>;
      }
    >(
      (
        _event,
        {
          shipmentIdField,
          targetRouteField,
          shipments,
          baseShipments,
          routes,
          history,
          lastAction,
          sequence,
        },
      ) => {
        const shipmentId = sanitizeShipmentId(shipmentIdField.get());
        const routeList = routes.get() ?? [];
        const targetRoute = resolveRouteId(routeList, targetRouteField.get());

        if (!shipmentId || !targetRoute) return;

        const stored = shipments.get();
        const base = baseShipments.get();
        const existing = Array.isArray(stored) && stored.length > 0
          ? stored.map((entry) => ({ ...entry }))
          : Array.isArray(base)
          ? base.map((entry) => ({ ...entry }))
          : [];

        const index = existing.findIndex((entry) => entry.id === shipmentId);
        if (index === -1) return;

        const record = existing[index];
        if (record.route === targetRoute) {
          shipmentIdField.set("");
          targetRouteField.set("");
          return;
        }

        const capacityMap = new Map<string, number>();
        const usage = new Map<string, number>();
        for (const route of routeList) {
          capacityMap.set(route.id, route.capacity);
          usage.set(route.id, 0);
        }
        for (let i = 0; i < existing.length; i++) {
          if (i === index) continue;
          const entry = existing[i];
          usage.set(entry.route, (usage.get(entry.route) ?? 0) + entry.weight);
        }
        const targetCapacity = capacityMap.get(targetRoute) ?? 0;
        const currentLoad = usage.get(targetRoute) ?? 0;
        if (currentLoad + record.weight > targetCapacity) {
          const message =
            `Blocked move of ${shipmentId} to ${targetRoute}; capacity ${targetCapacity}`;
          const log = history.get();
          history.set([...(Array.isArray(log) ? log : []), message]);
          lastAction.set(message);
          const seq = (sequence.get() ?? 0) + 1;
          sequence.set(seq);
          shipmentIdField.set("");
          targetRouteField.set("");
          return;
        }

        const updated = existing.map((entry, position) => {
          if (position !== index) return { ...entry };
          return { id: entry.id, route: targetRoute, weight: entry.weight };
        });
        updated.sort((left, right) => left.id.localeCompare(right.id));
        shipments.set(updated);

        const message =
          `Moved ${shipmentId} from ${record.route} to ${targetRoute}`;
        const log = history.get();
        history.set([...(Array.isArray(log) ? log : []), message]);
        lastAction.set(message);
        const seq = (sequence.get() ?? 0) + 1;
        sequence.set(seq);

        shipmentIdField.set("");
        targetRouteField.set("");
      },
    );

    const reassign = uiReassignHandler({
      shipmentIdField,
      targetRouteField,
      shipments: shipmentStore,
      baseShipments,
      routes: routesList,
      history,
      lastAction,
      sequence,
    });

    const name = str`Logistics Routing`;

    const ui = (
      <ct-card style="padding: 1.5rem; max-width: 1200px; margin: 0 auto;">
        <h1 style="margin: 0 0 0.5rem 0; font-size: 1.75rem; font-weight: 600;">
          📦 Logistics Routing
        </h1>
        <p style="margin: 0 0 1.5rem 0; color: #666;">
          Manage shipment assignments across delivery routes while respecting
          capacity constraints.
        </p>

        <ct-card style="padding: 1rem; margin-bottom: 1.5rem; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white;">
          <div style="font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.25rem;">
            System Status
          </div>
          <div style="font-size: 1.5rem; font-weight: 600;">{status}</div>
        </ct-card>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-bottom: 1.5rem;">
          <ct-card style="padding: 1rem;">
            <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600;">
              🚚 Routes
            </h2>
            {lift((metrics: RouteLoadMetric[]) => {
              const elements = [];
              for (const metric of metrics) {
                const percentage = metric.capacity > 0
                  ? String(
                    Math.round((metric.used / metric.capacity) * 100),
                  )
                  : "0";
                const bgColor = metric.isOverCapacity
                  ? "#fee"
                  : metric.remaining === 0
                  ? "#fef3c7"
                  : "#f0fdf4";
                const borderColor = metric.isOverCapacity
                  ? "#ef4444"
                  : metric.remaining === 0
                  ? "#f59e0b"
                  : "#22c55e";
                const cardStyle =
                  "padding: 0.875rem; margin-bottom: 0.75rem; border: 2px solid " +
                  borderColor + "; border-radius: 0.5rem; background: " +
                  bgColor + ";";
                const barWidth = Math.min(
                  (metric.used / metric.capacity) * 100,
                  100,
                );
                const barStyle = "height: 6px; background: " + borderColor +
                  "; border-radius: 3px; width: " + String(barWidth) + "%;";

                elements.push(
                  <div style={cardStyle}>
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                      <div style="font-weight: 600; font-size: 1rem;">
                        {metric.label}
                      </div>
                      <div style="font-size: 0.875rem; font-family: monospace; font-weight: 600;">
                        {metric.id}
                      </div>
                    </div>
                    <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem; font-size: 0.875rem;">
                      <span>
                        Load: <strong>{String(metric.used)}</strong> /{" "}
                        {String(metric.capacity)}
                      </span>
                      <span>
                        Remaining: <strong>{String(metric.remaining)}</strong>
                      </span>
                    </div>
                    <div style="background: #e5e7eb; height: 6px; border-radius: 3px; overflow: hidden;">
                      <div style={barStyle}></div>
                    </div>
                    <div style="margin-top: 0.25rem; font-size: 0.75rem; text-align: right; font-weight: 600;">
                      {percentage}% utilized
                    </div>
                  </div>,
                );
              }
              return <div>{elements}</div>;
            })(loadMetrics)}
          </ct-card>

          <ct-card style="padding: 1rem;">
            <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600;">
              📦 Shipments
            </h2>
            <div style="max-height: 400px; overflow-y: auto;">
              {lift((shipments: ShipmentRecord[]) => {
                const elements = [];
                for (const shipment of shipments) {
                  const cardStyle =
                    "padding: 0.75rem; margin-bottom: 0.5rem; border: 1px solid #e5e7eb; border-radius: 0.375rem; background: white;";
                  elements.push(
                    <div style={cardStyle}>
                      <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>
                          <div style="font-weight: 600; font-family: monospace; color: #1f2937;">
                            {shipment.id}
                          </div>
                          <div style="font-size: 0.875rem; color: #6b7280; margin-top: 0.25rem;">
                            Route: <strong>{shipment.route}</strong>
                          </div>
                        </div>
                        <div style="background: #dbeafe; color: #1e40af; padding: 0.375rem 0.75rem; border-radius: 0.375rem; font-weight: 600; font-size: 0.875rem;">
                          {String(shipment.weight)} kg
                        </div>
                      </div>
                    </div>,
                  );
                }
                return <div>{elements}</div>;
              })(assignmentList)}
            </div>
          </ct-card>
        </div>

        <ct-card style="padding: 1rem; margin-bottom: 1.5rem;">
          <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600;">
            🔄 Reassign Shipment
          </h2>
          <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 0.75rem; align-items: end;">
            <div>
              <label style="display: block; margin-bottom: 0.375rem; font-size: 0.875rem; font-weight: 500; color: #374151;">
                Shipment ID
              </label>
              <ct-input
                $value={shipmentIdField}
                placeholder="PKG-100"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; margin-bottom: 0.375rem; font-size: 0.875rem; font-weight: 500; color: #374151;">
                Target Route
              </label>
              <ct-input
                $value={targetRouteField}
                placeholder="NORTH"
                style="width: 100%;"
              />
            </div>
            <ct-button onClick={reassign} style="padding: 0.5rem 1.5rem;">
              Move Shipment
            </ct-button>
          </div>
          <div style="margin-top: 1rem; padding: 0.75rem; background: #f9fafb; border-radius: 0.375rem; font-size: 0.875rem; color: #6b7280;">
            <strong>Last Action:</strong> {lastActionView}
          </div>
        </ct-card>

        <ct-card style="padding: 1rem;">
          <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600;">
            📋 Activity History
          </h2>
          {lift((entries: string[]) => {
            if (entries.length === 0) {
              return (
                <div style="color: #9ca3af; font-style: italic; padding: 1rem; text-align: center;">
                  No activity yet
                </div>
              );
            }
            const reversed = entries.slice().reverse();
            const recent = reversed.slice(0, 10);
            const elements = [];
            for (const entry of recent) {
              const isBlocked = entry.includes("Blocked");
              const bgColor = isBlocked ? "#fef2f2" : "#f0fdf4";
              const textColor = isBlocked ? "#991b1b" : "#166534";
              const icon = isBlocked ? "❌" : "✅";
              const entryStyle =
                "padding: 0.75rem; margin-bottom: 0.5rem; background: " +
                bgColor + "; color: " + textColor +
                "; border-radius: 0.375rem; font-size: 0.875rem;";
              elements.push(
                <div style={entryStyle}>
                  {icon} {entry}
                </div>,
              );
            }
            return <div>{elements}</div>;
          })(historyView)}
        </ct-card>
      </ct-card>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      routes: routesList,
      shipments: assignmentList,
      loadMetrics,
      availableRoutes,
      overloadedRoutes: overloaded,
      status,
      history: historyView,
      lastAction: lastActionView,
      assignShipment,
    };
  },
);

export type { RouteDefinition, RouteLoadMetric, ShipmentRecord };
