// Polyfill Buffer for browser before any SDK modules execute
import { Buffer } from "buffer";

(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
