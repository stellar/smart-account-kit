import { afterEach, describe, expect, it, vi } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import { SmartAccountKit } from "./kit";
import { DEFAULT_INDEXER_URLS, IndexerClient } from "./indexer";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("IndexerClient network defaults", () => {
  it("includes Mercury default URLs for Stellar testnet and mainnet", () => {
    expect(DEFAULT_INDEXER_URLS["Test SDF Network ; September 2015"]).toBe(
      "https://testnet.mercurydata.app/rest/smart-account-indexer"
    );
    expect(
      DEFAULT_INDEXER_URLS["Public Global Stellar Network ; September 2015"]
    ).toBe("https://mainnet.mercurydata.app/rest/smart-account-indexer");
  });

  it("creates clients for both known Stellar networks", () => {
    expect(
      IndexerClient.forNetwork("Test SDF Network ; September 2015")
    ).not.toBeNull();
    expect(
      IndexerClient.forNetwork("Public Global Stellar Network ; September 2015")
    ).not.toBeNull();
  });

  it("sends a configured provider token as a bearer token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const indexer = new IndexerClient({
      baseUrl: "https://indexer.example/",
      authToken: "test-provider-token",
    });

    await expect(indexer.isHealthy()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://indexer.example/",
      expect.objectContaining({
        headers: {
          Accept: "application/json",
          Authorization: "Bearer test-provider-token",
        },
      })
    );
  });

  it("supports bearer tokens with network-default clients", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const indexer = IndexerClient.forNetwork(
      "Test SDF Network ; September 2015",
      { authToken: "network-token" }
    );

    await expect(indexer?.isHealthy()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_INDEXER_URLS["Test SDF Network ; September 2015"]}/`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer network-token",
        }),
      })
    );
  });

  it("omits Authorization when no token is configured", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.isHealthy()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://indexer.example/",
      expect.objectContaining({
        headers: { Accept: "application/json" },
      })
    );
  });

  it("fetches indexer statistics from the /api/stats endpoint", async () => {
    const statsBody = {
      stats: {
        total_events: 42,
        unique_contracts: 7,
        unique_credentials: 5,
        first_ledger: 100,
        last_ledger: 900,
        eventTypes: [{ event_type: "context_rule_added", count: 3 }],
      },
    };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(statsBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.getStats()).resolves.toEqual(statsBody);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://indexer.example/api/stats",
      expect.anything()
    );
  });

  it("forwards SmartAccountKit indexerAuthToken configuration", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const kit = new SmartAccountKit({
      rpcUrl: "https://rpc.example",
      networkPassphrase: "Test SDF Network ; September 2015",
      accountWasmHash: "00".repeat(32),
      webauthnVerifierAddress: "CEXAMPLE",
      indexerUrl: "https://indexer.example",
      indexerAuthToken: "kit-token",
    });

    await expect(kit.indexer?.isHealthy()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://indexer.example/",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer kit-token",
        }),
      })
    );
  });

  it("accepts only a complete schema-2 wallet-candidate response", async () => {
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
    const contract = {
      contract_id: contractId,
      context_rule_count: "1",
      external_signer_count: "1",
      delegated_signer_count: "0",
      native_signer_count: "0",
      first_seen_ledger: "100",
      last_seen_ledger: "200",
      context_rule_ids: [0],
      birth_wasm_hash: "ab".repeat(32),
      creation_transaction_hash: "12".repeat(32),
      creation_ledger: "100",
      current_wasm_hash: "cd".repeat(32),
      derived_address: true,
      collision: false,
      incomplete: false,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          schema: 2,
          complete: true,
          indexed_through_ledger: 200,
          credentialId: "0102",
          contracts: [contract],
          count: 1,
        })
      )
    );
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.lookupWalletCandidates("0102")).resolves.toEqual({
      schema: 2,
      complete: true,
      indexedThroughLedger: 200,
      candidates: [
        {
          contractId,
          birthWasmHash: "ab".repeat(32),
          creationTransactionHash: "12".repeat(32),
          creationLedger: 100,
          currentWasmHash: "cd".repeat(32),
          derivedAddress: true,
          collision: false,
        },
      ],
    });
  });

  it("keeps an incomplete schema-2 response untrusted", async () => {
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 8));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          schema: 2,
          complete: false,
          indexed_through_ledger: 200,
          credentialId: "0102",
          contracts: [
            {
              contract_id: contractId,
              context_rule_count: 1,
              external_signer_count: 1,
              delegated_signer_count: 0,
              native_signer_count: 0,
              first_seen_ledger: 100,
              last_seen_ledger: 200,
              context_rule_ids: [0],
              birth_wasm_hash: null,
              creation_transaction_hash: null,
              creation_ledger: null,
              current_wasm_hash: "cd".repeat(32),
              derived_address: false,
              collision: false,
              incomplete: true,
            },
          ],
          count: 1,
        })
      )
    );
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.lookupWalletCandidates("0102")).resolves.toEqual({
      schema: 2,
      complete: false,
      indexedThroughLedger: 200,
      candidates: [],
    });
  });

  it("rejects legacy credential responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          credentialId: "0102",
          contracts: [{
            contract_id: "CLEGACY",
            context_rule_count: 1,
            external_signer_count: 1,
            delegated_signer_count: 0,
            native_signer_count: 0,
            first_seen_ledger: 100,
            last_seen_ledger: 200,
            context_rule_ids: [0],
          }],
          count: 1,
        })
      )
    );
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.lookupWalletCandidates("0102")).rejects.toThrow(
      /invalid schema-2 credential response/i
    );
  });
});
