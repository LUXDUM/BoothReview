// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { extractItemIdFromUrl, findMountAnchor } from "../src/core/booth-dom.js";

describe("extractItemIdFromUrl", () => {
  it("extracts from booth.pm direct language paths", () => {
    expect(extractItemIdFromUrl("https://booth.pm/ja/items/123456")).toBe(123456);
    expect(extractItemIdFromUrl("https://booth.pm/en/items/1")).toBe(1);
  });

  it("extracts from shop subdomains", () => {
    expect(extractItemIdFromUrl("https://shopname.booth.pm/items/12345")).toBe(12345);
  });

  it("ignores query strings and keeps the id", () => {
    expect(extractItemIdFromUrl("https://a.booth.pm/items/777?foo=bar")).toBe(777);
  });

  it("returns null for non-item pages and foreign hosts", () => {
    expect(extractItemIdFromUrl("https://booth.pm/ja/")).toBeNull();
    expect(extractItemIdFromUrl("https://booth.pm/ja/items/")).toBeNull();
    expect(extractItemIdFromUrl("https://booth.pm/ja/items/abc")).toBeNull();
    expect(extractItemIdFromUrl("https://example.com/items/123")).toBeNull();
    expect(extractItemIdFromUrl("file:///C:/tmp/items/123")).toBeNull();
    expect(extractItemIdFromUrl("not a url")).toBeNull();
  });

  it("rejects ids that are zero or negative", () => {
    expect(extractItemIdFromUrl("https://a.booth.pm/items/0")).toBeNull();
  });
});

describe("findMountAnchor", () => {
  it("finds the first matching selector from the priority list", () => {
    const doc = new Document();
    const main = doc.createElement("main");
    doc.appendChild(main);
    expect(findMountAnchor(doc)).toBe(main);
  });

  it("falls back to null when nothing matches", () => {
    const doc = new Document();
    expect(findMountAnchor(doc)).toBeNull();
  });
});
