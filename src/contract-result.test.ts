import { Address, Keypair, xdr } from "@stellar/stellar-sdk";
import { Ok } from "@stellar/stellar-sdk/contract";
import { describe, expect, it } from "vitest";
import {
  Client as SmartAccountClient,
  type Signer,
} from "smart-account-kit-bindings";
import { ContractError, PolicyNotFoundError, SignerNotFoundError } from "./errors";
import { readContextRule, listContextRules } from "./kit/context-rules";
import { PolicyManager } from "./managers/policy-manager";
import { SignerManager } from "./managers/signer-manager";

const CONTRACT_ID = "CDANWYENKH6PTTY6GDTMDAMYRHMU4SBRPX5NUDYDMTYVOIF32ASZFU4Y";
const POLICY_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const NETWORK = "Test SDF Network ; September 2015";
const SIGNER: Signer = {
  tag: "Delegated",
  values: [Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey()],
};

function clientWithSimulation(
  simulateTransaction: () => Promise<unknown>
): SmartAccountClient {
  return new SmartAccountClient({
    contractId: CONTRACT_ID,
    networkPassphrase: NETWORK,
    rpcUrl: "http://localhost:8000",
    allowHttp: true,
    server: { simulateTransaction } as never,
  });
}

function contractErrorClient(code: number): SmartAccountClient {
  return clientWithSimulation(async () => ({
    error: `HostError: Error(Contract, #${code})`,
  }));
}

function signerManager(wallet: SmartAccountClient): SignerManager {
  return new SignerManager({
    requireWallet: () => ({ wallet, contractId: CONTRACT_ID }),
    storage: {} as never,
    events: {} as never,
    webauthnVerifierAddress: CONTRACT_ID,
    createPasskey: async () => {
      throw new Error("unused");
    },
  });
}

function policyManager(wallet: SmartAccountClient): PolicyManager {
  return new PolicyManager({ requireWallet: () => ({ wallet }) });
}

describe("generated-client contract Err results", () => {
  // Unit-pins the helper's Ok branch, not a live path: no method in the current
  // bindings is Result-typed, so funcResToNative never wraps a success this way.
  // Kept because the helper's contract is "unwrap a rust result", and the sibling
  // repo's bindings do have Result-typed methods.
  it("unwraps an SDK Ok value instead of returning its wrapper", async () => {
    const wallet = contractErrorClient(3006);
    wallet.get_signer_id = async () => ({ result: new Ok(12) }) as never;

    await expect(signerManager(wallet).idOf(SIGNER)).resolves.toBe(12);
  });

  it("keeps SignerManager.idOf typed without translating transport failures", async () => {
    const transportError = new Error("429 Too Many Requests");
    const transportManager = signerManager(
      clientWithSimulation(async () => {
        throw transportError;
      })
    );
    await expect(transportManager.idOf(SIGNER)).rejects.toBe(transportError);

    await expect(signerManager(contractErrorClient(3006)).idOf(SIGNER)).rejects.toBeInstanceOf(
      SignerNotFoundError
    );
  });

  it("does not pass a get_signer_id Err into remove_signer", async () => {
    await expect(signerManager(contractErrorClient(3006)).remove(3, SIGNER)).rejects.toBeInstanceOf(
      SignerNotFoundError
    );
  });

  it("keeps PolicyManager.idOf typed for a get_policy_id Err", async () => {
    await expect(policyManager(contractErrorClient(3008)).idOf(POLICY_ID)).rejects.toBeInstanceOf(
      PolicyNotFoundError
    );
  });

  it("does not pass a get_policy_id Err into remove_policy", async () => {
    await expect(policyManager(contractErrorClient(3008)).remove(3, POLICY_ID)).rejects.toBeInstanceOf(
      PolicyNotFoundError
    );
  });

  it("throws a typed #3000 error from the get_context_rule fallback", async () => {
    await expect(readContextRule(contractErrorClient(3000), 9)).rejects.toMatchObject({
      contractCode: 3000,
      contractErrorName: "ContextRuleNotFound",
    });
  });

  it("filters a typed #3000 miss while listing stale context-rule ids", async () => {
    await expect(
      listContextRules(contractErrorClient(3000), {
        getContractDetailsFromIndexer: async () =>
          ({
            contractId: CONTRACT_ID,
            summary: {
              contract_id: CONTRACT_ID,
              context_rule_count: 1,
              external_signer_count: 0,
              delegated_signer_count: 0,
              native_signer_count: 0,
              first_seen_ledger: 1,
              last_seen_ledger: 1,
              context_rule_ids: [9],
            },
            contextRules: [{ context_rule_id: 9, signers: [], policies: [] }],
          }),
      })
    ).resolves.toEqual([]);
  });

  it("throws a typed get_signer_id Err while hydrating legacy rule XDR", async () => {
    const retval = xdr.ScVal.fromXDR(
      "AAAAEQAAAAEAAAAGAAAADwAAAAxjb250ZXh0X3R5cGUAAAAQAAAAAQAAAAEAAAAPAAAAB0RlZmF1bHQAAAAADwAAAAJpZAAAAAAAAwAAAAAAAAAPAAAABG5hbWUAAAAOAAAACG11bHRpc2lnAAAADwAAAAhwb2xpY2llcwAAABAAAAABAAAAAAAAAA8AAAAHc2lnbmVycwAAAAAQAAAAAQAAAAEAAAAQAAAAAQAAAAMAAAAPAAAACEV4dGVybmFsAAAAEgAAAAFkevvWN+lfFhWkw++/Y80InSk9v5KoH6wsQAK0qaATWwAAAA0AAABVBGpkWd9ATmaxASDAotqYT29IUVJTQQZAHUSdBt4RcvRvfInCDIUr0yJMoNJshArXwXmy01MrFLXLzsb6BQhcTEcy3/P5n6TiIqVBkIn8/K2hsVx+oQAAAAAAAA8AAAALdmFsaWRfdW50aWwAAAAAAQ==",
      "base64"
    );

    await expect(
      readContextRule(contractErrorClient(3006), 0, {
        rpc: { simulateTransaction: async () => ({ result: { retval } }) } as never,
        contractId: CONTRACT_ID,
        networkPassphrase: NETWORK,
      })
    ).rejects.toMatchObject({ contractCode: 3006 });
  });

  it("throws a typed get_policy_id Err while hydrating legacy rule XDR", async () => {
    const retval = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("context_type"),
        val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Default")]),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("id"),
        val: xdr.ScVal.scvU32(0),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("name"),
        val: xdr.ScVal.scvString("legacy"),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("policies"),
        val: xdr.ScVal.scvVec([
          xdr.ScVal.scvAddress(Address.fromString(POLICY_ID).toScAddress()),
        ]),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("signers"),
        val: xdr.ScVal.scvVec([]),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("valid_until"),
        val: xdr.ScVal.scvVoid(),
      }),
    ]);

    await expect(
      readContextRule(contractErrorClient(3008), 0, {
        rpc: { simulateTransaction: async () => ({ result: { retval } }) } as never,
        contractId: CONTRACT_ID,
        networkPassphrase: NETWORK,
      })
    ).rejects.toMatchObject({ contractCode: 3008 });
  });

  it("uses ContractError for registry-backed Err values", async () => {
    await expect(readContextRule(contractErrorClient(3000), 0)).rejects.toBeInstanceOf(
      ContractError
    );
  });
});
