import { afterEach, describe, expect, it, vi } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import { SmartAccountKit } from "./kit";
import { DEFAULT_INDEXER_URLS, IndexerClient } from "./indexer";

function makeSchema2Contract(
  seed: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    contract_id: StrKey.encodeContract(Buffer.alloc(32, seed)),
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
    ...overrides,
  };
}

function stubCredentialResponse(
  contracts: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {}
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        schema: 2,
        complete: true,
        indexed_through_ledger: 200,
        credentialId: "0102",
        contracts,
        count: contracts.length,
        ...overrides,
      })
    )
  );
}

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

  it("accepts the complete empty response for an expired credential", async () => {
    stubCredentialResponse([]);
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.lookupWalletCandidates("0102")).resolves.toEqual({
      schema: 2,
      complete: true,
      indexedThroughLedger: 200,
      candidates: [],
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
              incompleteReasons: ["missing_birth"],
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

  it("does not mark multiple non-derived candidates as a collision", async () => {
    stubCredentialResponse([
      makeSchema2Contract(9, { derived_address: false }),
      makeSchema2Contract(10, { derived_address: false }),
    ]);
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.lookupWalletCandidates("0102")).resolves.toMatchObject({
      complete: true,
      candidates: [
        { derivedAddress: false, collision: false },
        { derivedAddress: false, collision: false },
      ],
    });
  });

  it("marks derived and non-derived candidates as a collision", async () => {
    stubCredentialResponse([
      makeSchema2Contract(11, { collision: true }),
      makeSchema2Contract(12, {
        derived_address: false,
        collision: true,
      }),
    ]);
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.lookupWalletCandidates("0102")).resolves.toMatchObject({
      complete: true,
      candidates: [
        { derivedAddress: true, collision: true },
        { derivedAddress: false, collision: true },
      ],
    });
  });

  it("rejects collision flags that do not match candidate derivation", async () => {
    stubCredentialResponse([
      makeSchema2Contract(13),
      makeSchema2Contract(14, { derived_address: false }),
    ]);
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.lookupWalletCandidates("0102")).resolves.toMatchObject({
      complete: false,
    });
  });

  it("rejects collision flags on only non-derived candidates", async () => {
    stubCredentialResponse([
      makeSchema2Contract(22, {
        derived_address: false,
        collision: true,
      }),
      makeSchema2Contract(23, {
        derived_address: false,
        collision: true,
      }),
    ]);
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.lookupWalletCandidates("0102")).resolves.toMatchObject({
      complete: false,
    });
  });

  it.each([
    "missing_birth",
    "rpc_unchecked",
    "signer_unconfirmed",
    "instance_missing",
    "wasm_unresolved",
    "inconsistent_creation_ledger",
  ])("accepts the candidate incomplete reason %s", async (reason) => {
    stubCredentialResponse(
      [
        makeSchema2Contract(15, {
          incomplete: true,
          incompleteReasons: [reason],
          birth_wasm_hash: null,
        }),
      ],
      { complete: false }
    );
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.lookupByCredentialId("0102")).resolves.toMatchObject({
      complete: false,
      contracts: [{ incomplete: true, incompleteReasons: [reason] }],
    });
  });

  it("rejects an unknown candidate incomplete reason", async () => {
    stubCredentialResponse(
      [
        makeSchema2Contract(16, {
          incomplete: true,
          incompleteReasons: ["unknown_reason"],
        }),
      ],
      { complete: false }
    );
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.lookupByCredentialId("0102")).rejects.toThrow(
      /invalid schema-2 credential response/i
    );
  });

  it("requires reasons for an incomplete candidate", async () => {
    stubCredentialResponse(
      [makeSchema2Contract(17, { incomplete: true })],
      { complete: false }
    );
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.lookupByCredentialId("0102")).rejects.toThrow(
      /invalid schema-2 credential response/i
    );
  });

  it("rejects an empty candidate incomplete reason list", async () => {
    stubCredentialResponse(
      [
        makeSchema2Contract(24, {
          incomplete: true,
          incompleteReasons: [],
        }),
      ],
      { complete: false }
    );
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.lookupByCredentialId("0102")).rejects.toThrow(
      /invalid schema-2 credential response/i
    );
  });

  it("forbids reasons on a complete candidate", async () => {
    stubCredentialResponse([
      makeSchema2Contract(18, { incompleteReasons: ["missing_birth"] }),
    ]);
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.lookupByCredentialId("0102")).rejects.toThrow(
      /invalid schema-2 credential response/i
    );
  });

  it.each(["reducer_errors", "index_behind"])(
    "accepts the response incomplete reason %s",
    async (reason) => {
      stubCredentialResponse([], {
        complete: false,
        incompleteReasons: [reason],
      });
      const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

      await expect(indexer.lookupByCredentialId("0102")).resolves.toMatchObject({
        complete: false,
        incompleteReasons: [reason],
      });
    }
  );

  it("rejects an unknown response incomplete reason", async () => {
    stubCredentialResponse([], {
      complete: false,
      incompleteReasons: ["unknown_reason"],
    });
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.lookupByCredentialId("0102")).rejects.toThrow(
      /invalid schema-2 credential response/i
    );
  });

  it("rejects an empty response incomplete reason list", async () => {
    stubCredentialResponse([], {
      complete: false,
      incompleteReasons: [],
    });
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.lookupByCredentialId("0102")).rejects.toThrow(
      /invalid schema-2 credential response/i
    );
  });

  it("forbids response incomplete reasons on a complete response", async () => {
    stubCredentialResponse([], { incompleteReasons: ["index_behind"] });
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.lookupByCredentialId("0102")).rejects.toThrow(
      /invalid schema-2 credential response/i
    );
  });

  it("accepts and preserves the historical signer-data discriminator", async () => {
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 19));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          contractId,
          summary: makeSchema2Contract(19),
          contextRules: [],
          signer_data: "historical",
        })
      )
    );
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.getContractDetails(contractId)).resolves.toMatchObject({
      signer_data: "historical",
    });
  });

  it("accepts a contract-detail response without signer_data", async () => {
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 20));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          contractId,
          summary: makeSchema2Contract(20),
          contextRules: [],
        })
      )
    );
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.getContractDetails(contractId)).resolves.toMatchObject({
      contractId,
    });
  });

  it("rejects another contract-detail signer_data value", async () => {
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 21));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          contractId,
          summary: makeSchema2Contract(21),
          contextRules: [],
          signer_data: "current",
        })
      )
    );
    const indexer = new IndexerClient({ baseUrl: "https://indexer.example" });

    await expect(indexer.getContractDetails(contractId)).rejects.toThrow(
      /invalid contract-detail response/i
    );
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
