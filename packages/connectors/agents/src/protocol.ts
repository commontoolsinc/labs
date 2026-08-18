export const AGENT_CONNECTOR_SCHEMAS = {
  session: "commonfabric.agent-connector.session.v1",
  sessionChunk: "commonfabric.agent-connector.session-chunk.v1",
  sessionIndex: "commonfabric.agent-connector.session-index.v1",
  health: "commonfabric.agent-connector.health.v1",
  command: "commonfabric.agent-connector.command.v1",
  commandReceipt: "commonfabric.agent-connector.command-receipt.v1",
  commandReceipts: "commonfabric.agent-connector.command-receipts.v1",
  commandLedger: "commonfabric.agent-connector.command-ledger.v2",
} as const;
