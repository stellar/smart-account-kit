import type { AuthenticationResponseJSON } from "@simplewebauthn/browser";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  hash,
  xdr,
} from "@stellar/stellar-sdk";
import { Api, type Server } from "@stellar/stellar-sdk/rpc";
import { describe, expect, it, vi } from "vitest";
import base64url from "../base64url.js";
import { signerToScVal } from "./auth-payload.js";
import {
  constructorArgsHash,
  contractIdFromCreateV2,
  verifyFreshAssertion,
  verifyWalletBirth,
} from "./wallet-provenance.js";

const NETWORK = Networks.TESTNET;
const WASM_HASH = "ab".repeat(32);
const OTHER_WASM_HASH = "cd".repeat(32);
const LEDGER = 987_654;
const SOURCE = Keypair.random();
const DEPLOYER = Keypair.random();
const VERIFIER = StrKey.encodeContract(Buffer.alloc(32, 7));
const CREDENTIAL_ID = base64url.encode(Buffer.from("credential-id"));
const CREDENTIAL_BYTES = base64url.toBuffer(CREDENTIAL_ID);
const SALT = hash(CREDENTIAL_BYTES);

function externalSigner(publicKey: Uint8Array, credential = CREDENTIAL_BYTES) {
  return {
    tag: "External" as const,
    values: [
      VERIFIER,
      Buffer.concat([Buffer.from(publicKey), credential]),
    ] as [string, Buffer],
  };
}

function buildCreation(options: {
  signers?: ReturnType<typeof externalSigner>[];
  policies?: xdr.ScVal;
  wasmHash?: string;
  deployer?: Keypair;
  salt?: Buffer;
} = {}) {
  const publicKey = new Uint8Array(65).fill(3);
  publicKey[0] = 0x04;
  const signers = options.signers ?? [externalSigner(publicKey)];
  const constructorArgs = [
    xdr.ScVal.scvVec(signers.map(signerToScVal)),
    options.policies ?? xdr.ScVal.scvMap([]),
  ];
  const transaction = new TransactionBuilder(
    new Account(SOURCE.publicKey(), "0"),
    { fee: "100", networkPassphrase: NETWORK }
  )
    .addOperation(
      Operation.createCustomContract({
        address: Address.fromString(
          (options.deployer ?? DEPLOYER).publicKey()
        ),
        wasmHash: Buffer.from(options.wasmHash ?? WASM_HASH, "hex"),
        salt: options.salt ?? SALT,
        constructorArgs,
      })
    )
    .setTimeout(0)
    .build();
  const operation = transaction.operations[0];
  if (
    operation?.type !== "invokeHostFunction" ||
    operation.func.switch().name !== "hostFunctionTypeCreateContractV2"
  ) {
    throw new Error("test did not build CreateContractV2");
  }
  const create = operation.func.createContractV2();
  const contractId = contractIdFromCreateV2(NETWORK, create);
  if (!contractId) throw new Error("test could not derive contract id");
  return {
    transaction,
    contractId,
    txHash: transaction.hash().toString("hex"),
    constructorArgs,
    signer: signers[0]!,
  };
}

function rpcFor(
  envelopeXdr: xdr.TransactionEnvelope,
  overrides: Record<string, unknown> = {}
): Server {
  return {
    getTransaction: vi.fn(async () => ({
      status: Api.GetTransactionStatus.SUCCESS,
      ledger: LEDGER,
      envelopeXdr,
      ...overrides,
    })),
  } as unknown as Server;
}

function candidate(contractId: string, txHash: string, wasm = WASM_HASH) {
  return {
    contractId,
    birthWasmHash: wasm,
    creationTransactionHash: txHash,
    creationLedger: LEDGER,
  };
}

describe("verifyWalletBirth", () => {
  it("accepts the exact deployer, salt, code, signer shape, and empty policies", async () => {
    const creation = buildCreation();
    const result = await verifyWalletBirth(
      {
        rpc: rpcFor(creation.transaction.toEnvelope()),
        networkPassphrase: NETWORK,
        acceptedBirthWasmHashes: [WASM_HASH],
        webauthnVerifierAddress: VERIFIER,
        expectedDeployer: DEPLOYER.publicKey(),
        expectedSalt: SALT,
        expectedPolicies: [],
      },
      candidate(creation.contractId, creation.txHash)
    );

    expect(result).toMatchObject({
      ok: true,
      birth: {
        contractId: creation.contractId,
        birthSigner: creation.signer,
        constructorArgsHash: constructorArgsHash(creation.constructorArgs),
      },
    });
  });

  it("rejects an extra attacker signer", async () => {
    const firstKey = new Uint8Array(65).fill(4);
    firstKey[0] = 0x04;
    const attackerKey = new Uint8Array(65).fill(5);
    attackerKey[0] = 0x04;
    const creation = buildCreation({
      signers: [externalSigner(firstKey), externalSigner(attackerKey)],
    });

    await expect(
      verifyWalletBirth(
        {
          rpc: rpcFor(creation.transaction.toEnvelope()),
          networkPassphrase: NETWORK,
          acceptedBirthWasmHashes: [WASM_HASH],
          webauthnVerifierAddress: VERIFIER,
          expectedDeployer: DEPLOYER.publicKey(),
          expectedSalt: SALT,
          expectedPolicies: [],
        },
        candidate(creation.contractId, creation.txHash)
      )
    ).resolves.toMatchObject({ ok: false, reason: "constructor_mismatch" });
  });

  it("rejects unexpected constructor policies", async () => {
    const policy = new xdr.ScMapEntry({
      key: Address.contract(Buffer.alloc(32, 9)).toScVal(),
      val: xdr.ScVal.scvVoid(),
    });
    const creation = buildCreation({ policies: xdr.ScVal.scvMap([policy]) });

    await expect(
      verifyWalletBirth(
        {
          rpc: rpcFor(creation.transaction.toEnvelope()),
          networkPassphrase: NETWORK,
          acceptedBirthWasmHashes: [WASM_HASH],
          webauthnVerifierAddress: VERIFIER,
          expectedDeployer: DEPLOYER.publicKey(),
          expectedSalt: SALT,
          expectedPolicies: [],
        },
        candidate(creation.contractId, creation.txHash)
      )
    ).resolves.toMatchObject({ ok: false, reason: "constructor_mismatch" });
  });

  it("rejects custom birth code even after a later accepted-code upgrade", async () => {
    const creation = buildCreation({ wasmHash: OTHER_WASM_HASH });

    await expect(
      verifyWalletBirth(
        {
          rpc: rpcFor(creation.transaction.toEnvelope()),
          networkPassphrase: NETWORK,
          acceptedBirthWasmHashes: [WASM_HASH],
          webauthnVerifierAddress: VERIFIER,
          expectedDeployer: DEPLOYER.publicKey(),
          expectedSalt: SALT,
          expectedPolicies: [],
        },
        candidate(creation.contractId, creation.txHash, OTHER_WASM_HASH)
      )
    ).resolves.toMatchObject({ ok: false, reason: "wasm_not_accepted" });
  });

  it("rejects the wrong deployer and salt", async () => {
    const creation = buildCreation();
    const base = {
      rpc: rpcFor(creation.transaction.toEnvelope()),
      networkPassphrase: NETWORK,
      acceptedBirthWasmHashes: [WASM_HASH],
      webauthnVerifierAddress: VERIFIER,
      expectedPolicies: [],
    };

    await expect(
      verifyWalletBirth(
        { ...base, expectedDeployer: Keypair.random().publicKey() },
        candidate(creation.contractId, creation.txHash)
      )
    ).resolves.toMatchObject({ ok: false, reason: "deployer_mismatch" });
    await expect(
      verifyWalletBirth(
        { ...base, expectedSalt: hash(Buffer.from("wrong")) },
        candidate(creation.contractId, creation.txHash)
      )
    ).resolves.toMatchObject({ ok: false, reason: "salt_mismatch" });
  });
});

function derFromCompact(compact: Uint8Array): Buffer {
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    let body = Buffer.from(bytes.subarray(start));
    if (body[0]! & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
    return Buffer.concat([Buffer.from([0x02, body.length]), body]);
  };
  const r = integer(compact.subarray(0, 32));
  const s = integer(compact.subarray(32));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}

async function freshAssertion(
  privateKey: CryptoKey,
  credentialId: string,
  challenge: string,
  rpId: string
): Promise<AuthenticationResponseJSON> {
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge,
      origin: `https://${rpId}`,
      crossOrigin: false,
    })
  );
  const authenticatorData = Buffer.concat([
    hash(Buffer.from(rpId)),
    Buffer.from([0x05]),
    Buffer.alloc(4),
  ]);
  const signed = Buffer.concat([authenticatorData, hash(clientDataJSON)]);
  const compact = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      signed
    )
  );
  return {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      authenticatorData: base64url.encode(authenticatorData),
      clientDataJSON: base64url.encode(clientDataJSON),
      signature: base64url.encode(derFromCompact(compact)),
    },
  };
}

describe("verifyFreshAssertion", () => {
  it("accepts the selected passkey and rejects an attacker public key", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );
    const attacker = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );
    const publicKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey)
    );
    const attackerPublicKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", attacker.publicKey)
    );
    const challenge = base64url.encode(hash(Buffer.from("fresh-proof")));
    const response = await freshAssertion(
      pair.privateKey,
      CREDENTIAL_ID,
      challenge,
      "example.com"
    );
    const policy = {
      expectedChallenge: challenge,
      expectedCredentialId: CREDENTIAL_ID,
      rpId: "example.com",
      publicKey,
      allowedOrigins: ["https://example.com"],
    };

    await expect(verifyFreshAssertion(response, policy)).resolves.toEqual({
      ok: true,
    });
    await expect(
      verifyFreshAssertion(response, {
        ...policy,
        publicKey: attackerPublicKey,
      })
    ).resolves.toMatchObject({ ok: false, reason: "signature" });

    await expect(
      verifyFreshAssertion(response, {
        ...policy,
        allowedOrigins: undefined,
      })
    ).resolves.toMatchObject({ ok: false, reason: "origin" });
  });
});
