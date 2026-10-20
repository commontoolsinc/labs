import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  LifecycleVerbFailure,
  PortEndpoint,
} from "../../src/executor/serving-port-protocol.ts";

type Requests = { value: { params: null; result: unknown } };
type Endpoint = PortEndpoint<
  Requests,
  Record<string, never>,
  Requests,
  Record<string, never>
>;

describe("serving-port-protocol", () => {
  it("rejects the caller when a handler's result cannot be cloned", async () => {
    const channel = new MessageChannel();
    const faults: Error[] = [];
    const client: Endpoint = new PortEndpoint(
      channel.port1,
      (error) => faults.push(error),
    );
    const server: Endpoint = new PortEndpoint(
      channel.port2,
      (error) => faults.push(error),
    );
    server.onRequest("value", () => () => {});
    try {
      await expect(client.request("value", null)).rejects.toThrow(
        "posting a ok message",
      );
      expect(faults).toHaveLength(1);
    } finally {
      client.close();
      server.close();
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("carries completed lifecycle phases with a refusal across the port", async () => {
    const channel = new MessageChannel();
    const client: Endpoint = new PortEndpoint(channel.port1, () => {});
    const server: Endpoint = new PortEndpoint(channel.port2, () => {});
    const refusal = Object.assign(new Error("cannot compile"), {
      name: "ServedLifecycleRefusal",
      code: "compile-failed",
    });
    const timings = [{ phase: "upload.run", ms: 123 }];
    server.onRequest("value", () => {
      throw new LifecycleVerbFailure(refusal, timings);
    });
    try {
      const failure = await client.request("value", null).then(
        () => {
          throw new Error("expected refusal");
        },
        (error) => error,
      );
      expect(failure).toBeInstanceOf(LifecycleVerbFailure);
      expect(failure.name).toBe(refusal.name);
      expect(failure.code).toBe(refusal.code);
      expect(failure.timings).toEqual(timings);
    } finally {
      client.close();
      server.close();
      channel.port1.close();
      channel.port2.close();
    }
  });
});
