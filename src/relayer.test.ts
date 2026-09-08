import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayerClient } from "./relayer";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("RelayerClient responses", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts canonical success responses with success=true and data payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          success: true,
          data: {
            transactionId: "tx-1",
            hash: "abc123",
            status: "submitted",
          },
        }),
      ) as unknown as typeof fetch,
    );

    const client = new RelayerClient("https://relay.example");
    const result = await client.send("AAAA", []);

    expect(result).toEqual({
      success: true,
      transactionId: "tx-1",
      hash: "abc123",
      status: "submitted",
    });
  });

  it("rejects responses without an explicit success field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          transactionId: "tx-2",
          hash: "def456",
          status: "submitted",
        }),
      ) as unknown as typeof fetch,
    );

    const client = new RelayerClient("https://relay.example");
    const result = await client.sendXdr("AAAA");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Relayer request failed with status 200");
  });

  it("prefers message text while preserving machine error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            success: false,
            error: "POOL_CAPACITY",
            errorCode: "POOL_CAPACITY",
            message: "The relay service is at capacity. Please retry shortly.",
            retryable: true,
          },
          503,
        ),
      ) as unknown as typeof fetch,
    );

    const client = new RelayerClient("https://relay.example");
    const result = await client.send("AAAA", []);

    expect(result.success).toBe(false);
    expect(result.error).toBe("The relay service is at capacity. Please retry shortly.");
    expect(result.errorCode).toBe("POOL_CAPACITY");
  });

  it("extracts nested machine code from data.code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            message: "Transaction simulation failed.",
            data: {
              code: "SIMULATION_FAILED",
              detail: "HostError ...",
            },
          },
          400,
        ),
      ) as unknown as typeof fetch,
    );

    const client = new RelayerClient("https://relay.example");
    const result = await client.send("AAAA", []);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("SIMULATION_FAILED");
    expect(result.error).toBe("Transaction simulation failed.");
  });
});
