import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalStorageAdapter } from "./localStorage";
import type { StoredCredential } from "../types";

class FakeLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  raw(): Map<string, string> {
    return this.store;
  }
}

let fake: FakeLocalStorage;

beforeEach(() => {
  fake = new FakeLocalStorage();
  vi.stubGlobal("localStorage", fake);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeCredential(id: string, contractId: string): StoredCredential {
  return {
    credentialId: id,
    publicKey: new Uint8Array([9, 8, 7]),
    contractId,
    createdAt: 1,
  };
}

describe("LocalStorageAdapter", () => {
  it("serializes and deserializes credentials (publicKey round-trips)", async () => {
    const store = new LocalStorageAdapter();
    await store.save(makeCredential("a", "C1"));
    const got = await store.get("a");
    expect(got?.credentialId).toBe("a");
    expect(got?.publicKey).toBeInstanceOf(Uint8Array);
    expect(Array.from(got!.publicKey)).toEqual([9, 8, 7]);
  });

  it("filters by contract, lists all, updates and deletes", async () => {
    const store = new LocalStorageAdapter();
    await store.save(makeCredential("a", "C1"));
    await store.save(makeCredential("b", "C2"));
    expect(await store.getByContract("C1")).toHaveLength(1);
    expect(await store.getAll()).toHaveLength(2);
    await store.update("a", { nickname: "n" });
    expect((await store.get("a"))?.nickname).toBe("n");
    await store.delete("a");
    expect(await store.get("a")).toBeNull();
  });

  it("stores and reads sessions", async () => {
    const store = new LocalStorageAdapter();
    await store.saveSession({ contractId: "C1", credentialId: "a", connectedAt: 1, expiresAt: 2 });
    expect((await store.getSession())?.contractId).toBe("C1");
    expect(fake.getItem("smart-account-kit:session")).not.toBeNull();
    await store.clearSession();
    expect(await store.getSession()).toBeNull();
  });

  it("scopes custom sessions and clears only the matching adapter's data", async () => {
    const appA = new LocalStorageAdapter("app-a");
    const appB = new LocalStorageAdapter("app-b");

    await appA.save(makeCredential("credential-a", "wallet-a"));
    await appB.save(makeCredential("credential-b", "wallet-b"));
    await appA.saveSession({ contractId: "wallet-a", credentialId: "credential-a", connectedAt: 1 });
    await appB.saveSession({ contractId: "wallet-b", credentialId: "credential-b", connectedAt: 2 });

    expect((await appA.getSession())?.contractId).toBe("wallet-a");
    expect((await appB.getSession())?.contractId).toBe("wallet-b");

    await appA.clearSession();
    expect(await appA.getSession()).toBeNull();
    expect(await appA.get("credential-a")).not.toBeNull();
    expect((await appB.getSession())?.contractId).toBe("wallet-b");

    await appA.saveSession({ contractId: "wallet-a", credentialId: "credential-a", connectedAt: 3 });
    await appA.clear();

    expect(await appA.get("credential-a")).toBeNull();
    expect(await appA.getSession()).toBeNull();
    expect(await appB.get("credential-b")).not.toBeNull();
    expect((await appB.getSession())?.contractId).toBe("wallet-b");
    expect(fake.getItem("smart-account-kit:session:app-b")).not.toBeNull();
  });

  it("avoids collisions with the default session key and other custom credential keys", async () => {
    const defaultStore = new LocalStorageAdapter();
    const prefixCollision = new LocalStorageAdapter("smart-account-kit");
    const app = new LocalStorageAdapter("app");
    const appSessionKey = new LocalStorageAdapter("app:session");

    await defaultStore.saveSession({ contractId: "default-wallet", credentialId: "c0", connectedAt: 1 });
    await prefixCollision.saveSession({ contractId: "custom-wallet", credentialId: "c1", connectedAt: 2 });
    await app.save(makeCredential("c2", "wallet-app"));
    await appSessionKey.save(makeCredential("c3", "wallet-app-session"));
    await app.saveSession({ contractId: "wallet-app", credentialId: "c2", connectedAt: 3 });
    await appSessionKey.saveSession({ contractId: "wallet-app-session", credentialId: "c3", connectedAt: 4 });

    expect((await defaultStore.getSession())?.contractId).toBe("default-wallet");
    expect((await prefixCollision.getSession())?.contractId).toBe("custom-wallet");
    expect((await appSessionKey.get("c3"))?.contractId).toBe("wallet-app-session");

    await prefixCollision.clear();
    await app.clearSession();

    expect((await defaultStore.getSession())?.contractId).toBe("default-wallet");
    expect((await appSessionKey.get("c3"))?.contractId).toBe("wallet-app-session");
    expect((await appSessionKey.getSession())?.contractId).toBe("wallet-app-session");
  });

  it("rejects empty or reserved session storage keys", () => {
    expect(() => new LocalStorageAdapter("")).toThrow(/non-empty/);
    expect(() => new LocalStorageAdapter("smart-account-kit:session")).toThrow(/reserved/);
    expect(() => new LocalStorageAdapter("smart-account-kit:session:other")).toThrow(/reserved/);
  });

  it("warns loudly and returns empty on corrupt credential data (no silent reset)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new LocalStorageAdapter();
    fake.setItem("smart-account-kit:credentials", "{ not valid json");

    expect(await store.getAll()).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
    // The corrupt data must NOT be silently overwritten by the read.
    expect(fake.getItem("smart-account-kit:credentials")).toBe("{ not valid json");
  });

  it("warns and ignores a corrupt session", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new LocalStorageAdapter();
    fake.setItem("smart-account-kit:session", "not json");
    expect(await store.getSession()).toBeNull();
    expect(consoleError).toHaveBeenCalled();
  });

  it("handles unavailable localStorage consistently", async () => {
    vi.stubGlobal("localStorage", undefined);
    const store = new LocalStorageAdapter("ssr-app");
    await expect(store.getAll()).rejects.toThrow(/localStorage is not available/);
    await expect(
      store.saveSession({ contractId: "C1", credentialId: "a", connectedAt: 1 })
    ).rejects.toThrow(/localStorage is not available/);
    expect(await store.getSession()).toBeNull();
    await expect(store.clearSession()).resolves.toBeUndefined();
    await expect(store.clear()).resolves.toBeUndefined();
  });
});
