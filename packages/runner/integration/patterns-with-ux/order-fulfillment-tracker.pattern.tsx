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

const fulfillmentStatuses = [
  "pending",
  "picking",
  "packed",
  "shipped",
  "delivered",
  "cancelled",
] as const;

type FulfillmentStatus = typeof fulfillmentStatuses[number];

type FulfillmentStatusCounts = Record<FulfillmentStatus, number>;

interface OrderInput {
  id?: string;
  customer?: string;
  items?: number;
  status?: string;
}

interface OrderRecord {
  id: string;
  customer: string;
  items: number;
  status: FulfillmentStatus;
}

interface OrderSnapshot {
  id: string;
  customer: string;
  items: number;
  status: FulfillmentStatus;
  statusLabel: string;
}

interface FulfillmentBucket {
  status: FulfillmentStatus;
  label: string;
  count: number;
  orders: OrderSnapshot[];
}

interface OrderFulfillmentTrackerArgs {
  orders: Default<OrderInput[], typeof defaultOrders>;
}

interface AdvanceFulfillmentEvent {
  orderId?: string;
  targetStatus?: string;
}

interface CancelOrderEvent {
  orderId?: string;
}

interface ReopenOrderEvent {
  orderId?: string;
}

interface StatusChange {
  order: OrderRecord;
  from: FulfillmentStatus;
  to: FulfillmentStatus;
}

interface StatusChangeEntry {
  sequence: number;
  orderId: string;
  customer: string;
  from: FulfillmentStatus;
  to: FulfillmentStatus;
  message: string;
}

interface FulfillmentHandlerContext {
  orders: Cell<OrderInput[]>;
  history: Cell<StatusChangeEntry[]>;
}

const statusLabels: Record<FulfillmentStatus, string> = {
  pending: "Pending",
  picking: "Picking",
  packed: "Packed",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

const fulfillmentStatusSet = new Set<FulfillmentStatus>(fulfillmentStatuses);

const inFlightStatuses = new Set<FulfillmentStatus>([
  "pending",
  "picking",
  "packed",
  "shipped",
]);

const fulfillmentFlow: readonly FulfillmentStatus[] = [
  "pending",
  "picking",
  "packed",
  "shipped",
  "delivered",
];

const defaultOrders: OrderRecord[] = [
  { id: "ORD-1001", customer: "Acme Labs", items: 4, status: "pending" },
  {
    id: "ORD-1002",
    customer: "Northwind",
    items: 2,
    status: "picking",
  },
  { id: "ORD-1003", customer: "Globex", items: 6, status: "packed" },
  { id: "ORD-1004", customer: "Initech", items: 3, status: "shipped" },
];

const fallbackOrderId = (index: number): string => {
  const value = (index + 1).toString().padStart(4, "0");
  return `ORD-${value}`;
};

const toOrderId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toUpperCase();
};

const sanitizeOrderId = (value: unknown, index: number): string =>
  toOrderId(value) ?? fallbackOrderId(index);

const sanitizeCustomer = (value: unknown, index: number): string => {
  if (typeof value !== "string") return `Customer ${index + 1}`;
  const trimmed = value.trim();
  return trimmed ? trimmed : `Customer ${index + 1}`;
};

const sanitizeItems = (value: unknown): number => {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 1;
  const integerValue = Math.floor(numberValue);
  return integerValue > 0 ? integerValue : 1;
};

const sanitizeStatus = (
  value: unknown,
  fallback: FulfillmentStatus,
): FulfillmentStatus => {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (fulfillmentStatusSet.has(normalized as FulfillmentStatus)) {
    return normalized as FulfillmentStatus;
  }
  return fallback;
};

const sanitizeOrder = (
  input: OrderInput | null | undefined,
  index: number,
): OrderRecord => {
  const id = sanitizeOrderId(input?.id, index);
  const customer = sanitizeCustomer(input?.customer, index);
  const items = sanitizeItems(input?.items);
  const status = sanitizeStatus(input?.status, "pending");
  return { id, customer, items, status };
};

const cloneOrders = (entries: readonly OrderRecord[]): OrderRecord[] =>
  entries.map((entry) => ({ ...entry }));

const sanitizeOrderList = (
  value: readonly OrderInput[] | undefined | null,
): OrderRecord[] => {
  if (!Array.isArray(value)) {
    return cloneOrders(defaultOrders);
  }
  const sanitized = value.map((entry, index) => sanitizeOrder(entry, index));
  sanitized.sort((left, right) => left.id.localeCompare(right.id));
  const seen = new Set<string>();
  const unique: OrderRecord[] = [];
  for (const entry of sanitized) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    unique.push(entry);
  }
  return unique.length > 0 ? unique : cloneOrders(defaultOrders);
};

const toOrderInputs = (records: readonly OrderRecord[]): OrderInput[] =>
  records.map((record) => ({
    id: record.id,
    customer: record.customer,
    items: record.items,
    status: record.status,
  }));

const createEmptyCounts = (): FulfillmentStatusCounts => {
  const counts: Partial<FulfillmentStatusCounts> = {};
  for (const status of fulfillmentStatuses) counts[status] = 0;
  return counts as FulfillmentStatusCounts;
};

const nextStatus = (status: FulfillmentStatus): FulfillmentStatus => {
  const index = fulfillmentFlow.indexOf(status);
  if (index === -1 || index === fulfillmentFlow.length - 1) return status;
  return fulfillmentFlow[index + 1];
};

const toSnapshot = (record: OrderRecord): OrderSnapshot => ({
  id: record.id,
  customer: record.customer,
  items: record.items,
  status: record.status,
  statusLabel: statusLabels[record.status],
});

const formatStatusChange = (change: StatusChange): string =>
  `${change.order.id} moved from ${statusLabels[change.from]} to ` +
  `${statusLabels[change.to]}`;

const recordStatusChange = (
  history: Cell<StatusChangeEntry[]>,
  change: StatusChange,
) => {
  const existing = history.get();
  const list = Array.isArray(existing) ? existing : [];
  const entry: StatusChangeEntry = {
    sequence: list.length + 1,
    orderId: change.order.id,
    customer: change.order.customer,
    from: change.from,
    to: change.to,
    message: formatStatusChange(change),
  };
  history.set([...list, entry]);
};

const applyStatusChange = (
  list: OrderRecord[],
  orderId: string,
  resolveStatus: (order: OrderRecord) => FulfillmentStatus | null,
): { list: OrderRecord[]; change: StatusChange | null } => {
  const index = list.findIndex((entry) => entry.id === orderId);
  if (index === -1) return { list, change: null };
  const current = list[index];
  const status = resolveStatus(current);
  if (!status || status === current.status) return { list, change: null };
  const updated = cloneOrders(list);
  updated[index] = { ...current, status };
  return {
    list: updated,
    change: { order: updated[index], from: current.status, to: status },
  };
};

const advanceFulfillment = handler<
  AdvanceFulfillmentEvent,
  FulfillmentHandlerContext
>((event, context) => {
  const orderId = toOrderId(event.orderId);
  if (!orderId) return;
  const current = sanitizeOrderList(context.orders.get());
  const result = applyStatusChange(current, orderId, (order) => {
    if (typeof event.targetStatus === "string") {
      return sanitizeStatus(event.targetStatus, order.status);
    }
    return nextStatus(order.status);
  });
  if (!result.change) return;
  context.orders.set(toOrderInputs(result.list));
  recordStatusChange(context.history, result.change);
});

const cancelOrder = handler<CancelOrderEvent, FulfillmentHandlerContext>(
  (event, context) => {
    const orderId = toOrderId(event.orderId);
    if (!orderId) return;
    const current = sanitizeOrderList(context.orders.get());
    const result = applyStatusChange(current, orderId, (order) => {
      if (order.status === "delivered" || order.status === "cancelled") {
        return null;
      }
      return "cancelled";
    });
    if (!result.change) return;
    context.orders.set(toOrderInputs(result.list));
    recordStatusChange(context.history, result.change);
  },
);

const reopenOrder = handler<ReopenOrderEvent, FulfillmentHandlerContext>(
  (event, context) => {
    const orderId = toOrderId(event.orderId);
    if (!orderId) return;
    const current = sanitizeOrderList(context.orders.get());
    const result = applyStatusChange(current, orderId, (order) => {
      if (order.status !== "cancelled") return null;
      return "pending";
    });
    if (!result.change) return;
    context.orders.set(toOrderInputs(result.list));
    recordStatusChange(context.history, result.change);
  },
);

export const orderFulfillmentTrackerUx = recipe<OrderFulfillmentTrackerArgs>(
  "Order Fulfillment Tracker",
  ({ orders }) => {
    const transitionLog = cell<StatusChangeEntry[]>([]);
    const selectedOrderId = cell<string>("");

    const ordersView = lift(sanitizeOrderList)(orders);

    const statusCounts = lift(
      (entries: OrderRecord[]): FulfillmentStatusCounts => {
        const counts = createEmptyCounts();
        for (const entry of entries) counts[entry.status] += 1;
        return counts;
      },
    )(ordersView);

    const pendingCount = lift((counts: FulfillmentStatusCounts) =>
      counts.pending
    )(statusCounts);
    const pickingCount = lift((counts: FulfillmentStatusCounts) =>
      counts.picking
    )(statusCounts);
    const packedCount = lift((counts: FulfillmentStatusCounts) =>
      counts.packed
    )(statusCounts);
    const shippedCount = lift((counts: FulfillmentStatusCounts) =>
      counts.shipped
    )(statusCounts);

    const totalOrders = lift((counts: FulfillmentStatusCounts) => {
      let total = 0;
      for (const status of fulfillmentStatuses) total += counts[status];
      return total;
    })(statusCounts);

    const activeOrders = lift((counts: FulfillmentStatusCounts) => {
      let total = 0;
      for (const status of inFlightStatuses) total += counts[status];
      return total;
    })(statusCounts);

    const queueSummary = lift((counts: FulfillmentStatusCounts) =>
      `Pending ${counts.pending}, Picking ${counts.picking}, ` +
      `Packed ${counts.packed}, Shipped ${counts.shipped}`
    )(statusCounts);

    const progressLabel =
      str`${activeOrders} active / ${totalOrders} total orders`;

    const statusBuckets = lift(
      (entries: OrderRecord[]): FulfillmentBucket[] => {
        const buckets = fulfillmentStatuses.map((status) => ({
          status,
          label: statusLabels[status],
          count: 0,
          orders: [] as OrderSnapshot[],
        }));
        const lookup = new Map<FulfillmentStatus, FulfillmentBucket>();
        for (const bucket of buckets) lookup.set(bucket.status, bucket);
        for (const entry of entries) {
          const bucket = lookup.get(entry.status);
          if (!bucket) continue;
          bucket.count += 1;
          bucket.orders.push(toSnapshot(entry));
        }
        for (const bucket of buckets) {
          bucket.orders.sort((left, right) => left.id.localeCompare(right.id));
        }
        return buckets;
      },
    )(ordersView);

    const inFlightOrderIds = lift((entries: OrderRecord[]) =>
      entries
        .filter((entry) => inFlightStatuses.has(entry.status))
        .map((entry) => entry.id)
    )(ordersView);

    const transitionHistory = lift((entries: StatusChangeEntry[]) =>
      entries.map((entry) => ({
        sequence: entry.sequence,
        orderId: entry.orderId,
        customer: entry.customer,
        from: statusLabels[entry.from],
        to: statusLabels[entry.to],
        message: entry.message,
      }))
    )(transitionLog);

    const transitionMessages = lift((entries: StatusChangeEntry[]) =>
      entries.map((entry) => entry.message)
    )(transitionLog);

    const fulfillmentProgress = lift((counts: FulfillmentStatusCounts) => {
      const total = counts.pending + counts.picking + counts.packed +
        counts.shipped + counts.delivered + counts.cancelled;
      if (total === 0) return 0;
      const completed = counts.delivered;
      return Math.round((completed / total) * 100);
    })(statusCounts);

    const name = str`Order Fulfillment Tracker`;

    // Handlers for UI
    const performAdvance = handler<{}, FulfillmentHandlerContext>(
      (_event, context) => {
        const orderId = toOrderId(selectedOrderId.get());
        if (!orderId) return;
        const current = sanitizeOrderList(context.orders.get());
        const result = applyStatusChange(
          current,
          orderId,
          (order) => nextStatus(order.status),
        );
        if (!result.change) return;
        context.orders.set(toOrderInputs(result.list));
        recordStatusChange(context.history, result.change);
      },
    );

    const performCancel = handler<{}, FulfillmentHandlerContext>(
      (_event, context) => {
        const orderId = toOrderId(selectedOrderId.get());
        if (!orderId) return;
        const current = sanitizeOrderList(context.orders.get());
        const result = applyStatusChange(current, orderId, (order) => {
          if (order.status === "delivered" || order.status === "cancelled") {
            return null;
          }
          return "cancelled";
        });
        if (!result.change) return;
        context.orders.set(toOrderInputs(result.list));
        recordStatusChange(context.history, result.change);
      },
    );

    const performReopen = handler<{}, FulfillmentHandlerContext>(
      (_event, context) => {
        const orderId = toOrderId(selectedOrderId.get());
        if (!orderId) return;
        const current = sanitizeOrderList(context.orders.get());
        const result = applyStatusChange(current, orderId, (order) => {
          if (order.status !== "cancelled") return null;
          return "pending";
        });
        if (!result.change) return;
        context.orders.set(toOrderInputs(result.list));
        recordStatusChange(context.history, result.change);
      },
    );

    const statusColors: Record<FulfillmentStatus, string> = {
      pending: "#f59e0b",
      picking: "#3b82f6",
      packed: "#8b5cf6",
      shipped: "#06b6d4",
      delivered: "#10b981",
      cancelled: "#ef4444",
    };

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 56rem;
            padding: 1rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1.25rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    color: #475569;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                  ">
                  Order Fulfillment Tracker
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Track orders through fulfillment pipeline
                </h2>
              </div>

              <div style="
                  background: linear-gradient(135deg, #f0f9ff 0%, #fef3c7 100%);
                  border-radius: 0.75rem;
                  padding: 1rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: baseline;
                  ">
                  <span style="font-size: 0.8rem; color: #475569;">
                    {progressLabel}
                  </span>
                  <strong style="font-size: 1.5rem; color: #0f172a;">
                    {fulfillmentProgress}% completed
                  </strong>
                </div>

                <div style="
                    position: relative;
                    height: 0.5rem;
                    background: #e2e8f0;
                    border-radius: 0.25rem;
                    overflow: hidden;
                  ">
                  <div
                    style={lift(
                      (pct: number) =>
                        `position: absolute; left: 0; top: 0; bottom: 0; width: ${pct}%; background: linear-gradient(90deg, #f59e0b, #10b981); border-radius: 0.25rem; transition: width 0.2s ease;`,
                    )(fulfillmentProgress)}
                  >
                  </div>
                </div>

                <div style="
                    font-size: 0.75rem;
                    color: #64748b;
                  ">
                  Pipeline: {queueSummary}
                </div>
              </div>
            </div>
          </ct-card>

          <div style="
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
              gap: 1rem;
            ">
            {lift((buckets: FulfillmentBucket[]) =>
              buckets.map((bucket) => (
                <ct-card key={bucket.status}>
                  <div
                    slot="header"
                    style="
                      display: flex;
                      justify-content: space-between;
                      align-items: center;
                    "
                  >
                    <div style="
                        display: flex;
                        align-items: center;
                        gap: 0.5rem;
                      ">
                      <span
                        style={`
                          display: inline-block;
                          width: 0.75rem;
                          height: 0.75rem;
                          border-radius: 50%;
                          background: ${statusColors[bucket.status]};
                        `}
                      >
                      </span>
                      <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                        {bucket.label}
                      </h3>
                    </div>
                    <span style="
                        font-size: 1.25rem;
                        font-weight: 600;
                        color: #475569;
                      ">
                      {bucket.count}
                    </span>
                  </div>
                  <div
                    slot="content"
                    style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.75rem;
                    "
                  >
                    {bucket.orders.length === 0
                      ? (
                        <p style="
                          margin: 0;
                          font-size: 0.85rem;
                          color: #94a3b8;
                          font-style: italic;
                        ">
                          No orders in this stage
                        </p>
                      )
                      : bucket.orders.map((order) => (
                        <div
                          key={order.id}
                          style="
                            background: #f8fafc;
                            border: 1px solid #e2e8f0;
                            border-radius: 0.5rem;
                            padding: 0.75rem;
                          "
                        >
                          <div style="
                              font-weight: 600;
                              color: #0f172a;
                              font-size: 0.95rem;
                            ">
                            {order.id}
                          </div>
                          <div style="
                              font-size: 0.75rem;
                              color: #64748b;
                              margin-top: 0.15rem;
                            ">
                            {order.customer} • {order.items}{" "}
                            {order.items === 1 ? "item" : "items"}
                          </div>
                        </div>
                      ))}
                  </div>
                </ct-card>
              ))
            )(statusBuckets)}
          </div>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Order actions
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div style="display: flex; flex-direction: column; gap: 0.4rem;">
                <label
                  for="order-id"
                  style="font-size: 0.85rem; font-weight: 500; color: #334155;"
                >
                  Enter Order ID to perform actions
                </label>
                <ct-input
                  id="order-id"
                  $value={selectedOrderId}
                  placeholder="e.g., ORD-1001"
                  aria-label="Enter order ID"
                >
                </ct-input>
              </div>
              <div style="
                  display: flex;
                  gap: 0.75rem;
                  flex-wrap: wrap;
                ">
                <ct-button
                  onClick={performAdvance({
                    orders,
                    history: transitionLog,
                  })}
                >
                  Advance Status
                </ct-button>
                <ct-button
                  variant="secondary"
                  onClick={performCancel({
                    orders,
                    history: transitionLog,
                  })}
                >
                  Cancel Order
                </ct-button>
                <ct-button
                  variant="secondary"
                  onClick={performReopen({
                    orders,
                    history: transitionLog,
                  })}
                >
                  Reopen Order
                </ct-button>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Status change history
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
                max-height: 400px;
                overflow-y: auto;
              "
            >
              {lift((
                entries: Array<{
                  sequence: number;
                  orderId: string;
                  customer: string;
                  from: string;
                  to: string;
                  message: string;
                }>,
              ) => {
                if (entries.length === 0) {
                  return (
                    <p style="
                        margin: 0;
                        font-size: 0.85rem;
                        color: #94a3b8;
                        font-style: italic;
                      ">
                      No status changes yet
                    </p>
                  );
                }
                return entries.slice().reverse().map((entry) => (
                  <div
                    key={entry.sequence}
                    style="
                      background: #f8fafc;
                      border-left: 3px solid #3b82f6;
                      border-radius: 0.25rem;
                      padding: 0.75rem;
                      font-size: 0.85rem;
                    "
                  >
                    <div style="color: #0f172a; font-weight: 500;">
                      {entry.message}
                    </div>
                    <div style="
                        color: #64748b;
                        font-size: 0.75rem;
                        margin-top: 0.25rem;
                      ">
                      #{entry.sequence} • {entry.customer}
                    </div>
                  </div>
                ));
              })(transitionHistory)}
            </div>
          </ct-card>
        </div>
      ),
      orders,
      ordersView,
      statusCounts,
      statusBuckets,
      inFlightOrderIds,
      queueSummary,
      progressLabel,
      transitionHistory,
      transitionMessages,
      advanceFulfillment: advanceFulfillment({
        orders,
        history: transitionLog,
      }),
      cancelOrder: cancelOrder({ orders, history: transitionLog }),
      reopenOrder: reopenOrder({ orders, history: transitionLog }),
    };
  },
);

export default orderFulfillmentTrackerUx;

export type {
  FulfillmentBucket,
  FulfillmentStatus,
  FulfillmentStatusCounts,
  OrderFulfillmentTrackerArgs,
  OrderInput,
  OrderRecord,
  OrderSnapshot,
  StatusChangeEntry,
};
