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

    await appA.saveSession({ contractId: "wallet-a", credentialId: "credential-a", connectedAt: 1 });
    await appB.saveSession({ contractId: "wallet-b", credentialId: "credential-b", connectedAt: 2 });

    expect((await appA.getSession())?.contractId).toBe("wallet-a");
    expect((await appB.getSession())?.contractId).toBe("wallet-b");

    await appA.clear();

    expect(await appA.getSession()).toBeNull();
    expect((await appB.getSession())?.contractId).toBe("wallet-b");
    expect(fake.getItem("app-b:session")).not.toBeNull();
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

  it("throws when localStorage is unavailable", async () => {
    vi.stubGlobal("localStorage", undefined);
    const store = new LocalStorageAdapter();
    await expect(store.getAll()).rejects.toThrow();
  });
});
