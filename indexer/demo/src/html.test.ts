import { describe, expect, it } from "vitest";
import { escapeHtml } from "./html";

describe("escapeHtml", () => {
  it("escapes every HTML text and quoted-attribute control character", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("neutralizes element and attribute breakout payloads", () => {
    expect(escapeHtml("<img src=x onerror=alert(document.domain)>")).toBe(
      "&lt;img src=x onerror=alert(document.domain)&gt;"
    );
    expect(escapeHtml(`\"><img src=x onerror=alert(1)>`)).toBe(
      "&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"
    );
  });

  it("escapes existing entities without preserving markup", () => {
    expect(escapeHtml("&lt;script&gt;")).toBe("&amp;lt;script&amp;gt;");
  });

  it("handles nullish and non-string values", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42)).toBe("42");
  });
});
