import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fetchPinnedHttp } from "@commonfabric/utils/pinned-http-fetch";

interface FakeHttpConnection {
  conn: Deno.Conn;
  writes: Uint8Array[];
  isClosed(): boolean;
}

const createFakeHttpConnection = (
  response: string,
  options: { pendingRead?: boolean } = {},
): FakeHttpConnection => {
  const responseBytes = new TextEncoder().encode(response);
  const writes: Uint8Array[] = [];
  let offset = 0;
  let closed = false;
  const conn = {
    read(buffer: Uint8Array): Promise<number | null> {
      if (options.pendingRead) {
        return new Promise(() => {});
      }
      if (closed || offset >= responseBytes.byteLength) {
        return Promise.resolve(null);
      }
      const count = Math.min(
        buffer.byteLength,
        responseBytes.byteLength - offset,
      );
      buffer.set(responseBytes.slice(offset, offset + count));
      offset += count;
      return Promise.resolve(count);
    },
    write(buffer: Uint8Array): Promise<number> {
      writes.push(buffer.slice());
      return Promise.resolve(buffer.byteLength);
    },
    close(): void {
      closed = true;
    },
  } as unknown as Deno.Conn;
  return { conn, writes, isClosed: () => closed };
};

const withDenoConnect = async <T>(
  connect: typeof Deno.connect,
  fn: () => Promise<T>,
): Promise<T> => {
  const original = Deno.connect;
  Object.defineProperty(Deno, "connect", {
    configurable: true,
    writable: true,
    value: connect,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(Deno, "connect", {
      configurable: true,
      writable: true,
      value: original,
    });
  }
};

const decodeWrites = (writes: Uint8Array[]): string =>
  new TextDecoder().decode(
    writes.reduce((combined, bytes) => {
      const next = new Uint8Array(combined.byteLength + bytes.byteLength);
      next.set(combined);
      next.set(bytes, combined.byteLength);
      return next;
    }, new Uint8Array()),
  );

describe("fetchPinnedHttp", () => {
  it("sends arbitrary methods, headers, and replayable request bodies", async () => {
    const fake = createFakeHttpConnection([
      "HTTP/1.1 201 Created\r\n",
      "Content-Type: text/plain\r\n",
      "Content-Length: 2\r\n",
      "\r\n",
      "okignored",
    ].join(""));

    await withDenoConnect(
      (() => Promise.resolve(fake.conn)) as unknown as typeof Deno.connect,
      async () => {
        const response = await fetchPinnedHttp(
          new URL("http://example.com:8080/items?q=one"),
          "93.184.216.34",
          {
            method: "POST",
            headers: {
              "content-length": "999",
              "x-example": "present",
            },
            body: "hé",
          },
        );

        expect(response.status).toBe(201);
        expect(response.statusText).toBe("Created");
        expect(await response.text()).toBe("ok");
      },
    );

    const request = decodeWrites(fake.writes);
    expect(request).toContain("POST /items?q=one HTTP/1.1\r\n");
    expect(request).toContain("Host: example.com:8080\r\n");
    expect(request).toContain("Connection: close\r\n");
    expect(request).toContain("Accept-Encoding: identity\r\n");
    expect(request.toLowerCase()).toContain("content-length: 3\r\n");
    expect(request).toContain("x-example: present\r\n");
    expect(request.endsWith("\r\n\r\nhé")).toBe(true);
    expect(request).not.toContain("999");
    expect(fake.isClosed()).toBe(true);
  });

  it("decodes chunked responses and bounds their trailers", async () => {
    const fake = createFakeHttpConnection([
      "HTTP/1.1 200 OK\r\n",
      "Transfer-Encoding: chunked\r\n",
      "\r\n",
      "4;extension=value\r\n",
      "Wiki\r\n",
      "5\r\n",
      "pedia\r\n",
      "0\r\n",
      "X-Trailer: ignored\r\n",
      "\r\n",
    ].join(""));

    await withDenoConnect(
      (() => Promise.resolve(fake.conn)) as unknown as typeof Deno.connect,
      async () => {
        const response = await fetchPinnedHttp(
          new URL("http://example.com/chunked"),
          "93.184.216.34",
        );
        expect(await response.text()).toBe("Wikipedia");
      },
    );

    expect(fake.isClosed()).toBe(true);
  });

  it("streams connection-close responses", async () => {
    const fake = createFakeHttpConnection(
      "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nhello",
    );

    await withDenoConnect(
      (() => Promise.resolve(fake.conn)) as unknown as typeof Deno.connect,
      async () => {
        const response = await fetchPinnedHttp(
          new URL("http://example.com/close"),
          "93.184.216.34",
        );
        expect(await response.text()).toBe("hello");
      },
    );

    expect(fake.isClosed()).toBe(true);
  });

  it("returns a null body for HEAD without waiting for response bytes", async () => {
    const fake = createFakeHttpConnection(
      "HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\n",
    );

    await withDenoConnect(
      (() => Promise.resolve(fake.conn)) as unknown as typeof Deno.connect,
      async () => {
        const response = await fetchPinnedHttp(
          new URL("http://example.com/head"),
          "93.184.216.34",
          { method: "HEAD" },
        );
        expect(response.body).toBeNull();
      },
    );

    expect(fake.isClosed()).toBe(true);
  });

  it("retains the URL hostname for HTTPS certificate verification", async () => {
    const tcp = createFakeHttpConnection("");
    const tls = createFakeHttpConnection(
      "HTTP/1.1 204 No Content\r\n\r\n",
    );
    const originalStartTls = Deno.startTls;
    let tlsHostname: string | undefined;
    let tlsAlpnProtocols: string[] | undefined;
    Object.defineProperty(Deno, "startTls", {
      configurable: true,
      writable: true,
      value: (conn: Deno.Conn, options: Deno.StartTlsOptions) => {
        expect(conn).toBe(tcp.conn);
        tlsHostname = options.hostname;
        tlsAlpnProtocols = options.alpnProtocols;
        return Promise.resolve(tls.conn as Deno.TlsConn);
      },
    });
    try {
      await withDenoConnect(
        (() => Promise.resolve(tcp.conn)) as unknown as typeof Deno.connect,
        async () => {
          const response = await fetchPinnedHttp(
            new URL("https://Example.COM/resource"),
            "93.184.216.34",
          );
          expect(response.status).toBe(204);
          expect(response.body).toBeNull();
        },
      );
    } finally {
      Object.defineProperty(Deno, "startTls", {
        configurable: true,
        writable: true,
        value: originalStartTls,
      });
    }

    expect(tlsHostname).toBe("example.com");
    expect(tlsAlpnProtocols).toEqual(["http/1.1"]);
    expect(tls.isClosed()).toBe(true);
  });

  it("aborts an in-flight response and closes its connection", async () => {
    const fake = createFakeHttpConnection("", { pendingRead: true });
    const controller = new AbortController();

    await withDenoConnect(
      (() => Promise.resolve(fake.conn)) as unknown as typeof Deno.connect,
      async () => {
        const pending = fetchPinnedHttp(
          new URL("http://example.com/pending"),
          "93.184.216.34",
          { signal: controller.signal },
        );
        controller.abort(new DOMException("cancelled", "AbortError"));
        await expect(pending).rejects.toThrow("cancelled");
      },
    );

    expect(fake.isClosed()).toBe(true);
  });

  it("rejects oversized response headers before exposing a response", async () => {
    const fake = createFakeHttpConnection(
      `HTTP/1.1 200 OK\r\nX-Large: ${"x".repeat(128)}\r\n\r\n`,
    );

    await withDenoConnect(
      (() => Promise.resolve(fake.conn)) as unknown as typeof Deno.connect,
      async () => {
        await expect(fetchPinnedHttp(
          new URL("http://example.com/large"),
          "93.184.216.34",
          { maxResponseHeaderBytes: 64 },
        )).rejects.toThrow("response headers were incomplete or too large");
      },
    );

    expect(fake.isClosed()).toBe(true);
  });
});
