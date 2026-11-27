/**
 * localStorage Storage Adapter
 *
 * Simple localStorage-based storage for credentials. Works in browsers
 * and provides persistence across page reloads.
 *
 * Note: localStorage has a 5MB limit and data is not encrypted.
 * For production use, consider IndexedDB or server-side storage.
 */

import type { StorageAdapter, StoredCredential, StoredSession } from "../types.js";
import { LOCALSTORAGE_CREDENTIALS_KEY, LOCALSTORAGE_SESSION_KEY } from "../constants.js";

const STORAGE_KEY = LOCALSTORAGE_CREDENTIALS_KEY;
const SESSION_KEY = LOCALSTORAGE_SESSION_KEY;

/**
 * Serialized credential format for JSON storage
 * (publicKey is stored as number[] since Uint8Array isn't JSON-serializable)
 */
type SerializedCredential = Omit<StoredCredential, "publicKey"> & {
  publicKey: number[];
};

/**
 * Helper to serialize Uint8Array for JSON storage
 */
function serializeCredential(credential: StoredCredential): SerializedCredential {
  return {
    ...credential,
    publicKey: Array.from(credential.publicKey),
  };
}

/**
 * Helper to deserialize Uint8Array from JSON storage
 */
function deserializeCredential(data: SerializedCredential): StoredCredential {
  return {
    ...data,
    publicKey: new Uint8Array(data.publicKey),
  };
}

export class LocalStorageAdapter implements StorageAdapter {
  private storageKey: string;
  private sessionStorageKey: string;

  constructor(storageKey: string = STORAGE_KEY) {
    if (!storageKey) {
      throw new Error("storageKey must be a non-empty string");
    }
    if (
      storageKey === SESSION_KEY ||
      storageKey.startsWith(`${SESSION_KEY}:`)
    ) {
      throw new Error(
        `storageKey "${storageKey}" is reserved for session storage`
      );
    }
    this.storageKey = storageKey;
    // Keep the legacy key for the default adapter so existing sessions remain
    // available after upgrading. Custom adapters namespace sessions under
    // `${SESSION_KEY}:${storageKey}` so they cannot collide with the default
    // session key or with another adapter's credential key.
    this.sessionStorageKey =
      storageKey === STORAGE_KEY ? SESSION_KEY : `${SESSION_KEY}:${storageKey}`;
  }

  private getStorage(): Map<string, StoredCredential> {
    if (typeof localStorage === "undefined") {
      throw new Error("localStorage is not available in this environment");
    }

    const data = localStorage.getItem(this.storageKey);
    if (!data) {
      return new Map();
    }

    try {
      const parsed = JSON.parse(data) as Record<string, SerializedCredential>;
      const map = new Map<string, StoredCredential>();
      for (const [key, value] of Object.entries(parsed)) {
        map.set(key, deserializeCredential(value));
      }
      return map;
    } catch (error) {
      // Corrupt/unreadable storage: warn loudly rather than silently dropping
      // the user's stored credentials. We still return an empty Map so the app
      // keeps working, but the data loss is now visible.
      console.error(
        `[SmartAccountKit] Failed to parse stored credentials at "${this.storageKey}"; ` +
          `treating storage as empty. Existing data was not overwritten.`,
        error
      );
      return new Map();
    }
  }

  private setStorage(credentials: Map<string, StoredCredential>): void {
    const obj: Record<string, SerializedCredential> = {};
    for (const [key, value] of credentials.entries()) {
      obj[key] = serializeCredential(value);
    }
    localStorage.setItem(this.storageKey, JSON.stringify(obj));
  }

  async save(credential: StoredCredential): Promise<void> {
    const credentials = this.getStorage();
    credentials.set(credential.credentialId, credential);
    this.setStorage(credentials);
  }

  async get(credentialId: string): Promise<StoredCredential | null> {
    const credentials = this.getStorage();
    return credentials.get(credentialId) ?? null;
  }

  async getByContract(contractId: string): Promise<StoredCredential[]> {
    const credentials = this.getStorage();
    const results: StoredCredential[] = [];
    for (const credential of credentials.values()) {
      if (credential.contractId === contractId) {
        results.push(credential);
      }
    }
    return results;
  }

  async getAll(): Promise<StoredCredential[]> {
    const credentials = this.getStorage();
    return Array.from(credentials.values());
  }

  async delete(credentialId: string): Promise<void> {
    const credentials = this.getStorage();
    credentials.delete(credentialId);
    this.setStorage(credentials);
  }

  async update(
    credentialId: string,
    updates: Partial<Omit<StoredCredential, "credentialId" | "publicKey">>
  ): Promise<void> {
    const credentials = this.getStorage();
    const credential = credentials.get(credentialId);
    if (credential) {
      credentials.set(credentialId, { ...credential, ...updates });
      this.setStorage(credentials);
    }
  }

  async clear(): Promise<void> {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.removeItem(this.storageKey);
    localStorage.removeItem(this.sessionStorageKey);
  }

  async saveSession(session: StoredSession): Promise<void> {
    if (typeof localStorage === "undefined") {
      throw new Error("localStorage is not available in this environment");
    }
    localStorage.setItem(this.sessionStorageKey, JSON.stringify(session));
  }

  async getSession(): Promise<StoredSession | null> {
    if (typeof localStorage === "undefined") {
      return null;
    }
    const data = localStorage.getItem(this.sessionStorageKey);
    if (!data) {
      return null;
    }
    try {
      return JSON.parse(data);
    } catch (error) {
      console.error(
        `[SmartAccountKit] Failed to parse stored session at "${this.sessionStorageKey}"; ` +
          `ignoring the saved session.`,
        error
      );
      return null;
    }
  }

  async clearSession(): Promise<void> {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(this.sessionStorageKey);
    }
  }
}
