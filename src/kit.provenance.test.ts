import { beforeEach, describe, expect, it, vi } from "vitest";
import { SmartAccountKit } from "./kit";
import { connectWithCredentials } from "./kit/wallet-ops";

vi.mock("./kit/wallet-ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./kit/wallet-ops")>()),
  connectWithCredentials: vi.fn(async () => ({
    credentialId: "cred-1",
    contractId: "CABC",
  })),
}));

type ConnectDeps = Parameters<typeof connectWithCredentials>[0];

async function connectDeps(walletProvenance: unknown): Promise<ConnectDeps> {
  const connect = (
    SmartAccountKit.prototype as unknown as {
      connectWithCredentials: (
        credentialId?: string,
        contractId?: string
      ) => Promise<unknown>;
    }
  ).connectWithCredentials;
  await connect.call({ walletProvenance, indexer: null }, "cred-1", "CABC");
  return vi.mocked(connectWithCredentials).mock.calls.at(-1)![0];
}

describe("walletProvenance", () => {
  beforeEach(() => {
    vi.mocked(connectWithCredentials).mockClear();
  });

  it("keeps the built-in lookup and birth verification without hooks", async () => {
    const deps = await connectDeps(undefined);

    expect(deps.verifyBirth).toBeUndefined();
    // No indexer is configured, so the built-in lookup has no claim to return.
    expect(await deps.lookupWalletCandidates!("cred-1")).toBeNull();
  });

  it("passes the configured hooks to the connection", async () => {
    const lookupWalletCandidates = vi.fn();
    const verifyBirth = vi.fn();

    const deps = await connectDeps({ lookupWalletCandidates, verifyBirth });

    expect(deps.lookupWalletCandidates).toBe(lookupWalletCandidates);
    expect(deps.verifyBirth).toBe(verifyBirth);
  });

  it("keeps the built-in behaviour for a hook that is left out", async () => {
    const verifyBirth = vi.fn();

    const deps = await connectDeps({ verifyBirth });

    expect(deps.verifyBirth).toBe(verifyBirth);
    expect(await deps.lookupWalletCandidates!("cred-1")).toBeNull();
  });
});
