import { describe, expect, it } from "vitest";
import { extractClientIp, isIpInCidr, isTrustedProxy } from "../src/lib/ip.js";

describe("isIpInCidr", () => {
  it("matches IPv4 CIDR", () => {
    expect(isIpInCidr("172.18.0.9", "172.16.0.0/12")).toBe(true);
    expect(isIpInCidr("172.32.0.1", "172.16.0.0/12")).toBe(false);
    expect(isIpInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(isIpInCidr("192.168.1.1", "192.168.1.0/24")).toBe(true);
    expect(isIpInCidr("192.168.2.1", "192.168.1.0/24")).toBe(false);
    expect(isIpInCidr("127.0.0.1", "127.0.0.1/32")).toBe(true);
  });

  it("matches IPv6 CIDR", () => {
    expect(isIpInCidr("::1", "::1/128")).toBe(true);
    expect(isIpInCidr("::2", "::1/128")).toBe(false);
    expect(isIpInCidr("fd00::1", "fd00::/8")).toBe(true);
    expect(isIpInCidr("fe00::1", "fd00::/8")).toBe(false);
  });

  it("handles IPv4-mapped IPv6 as IPv4", () => {
    expect(isIpInCidr("::ffff:172.18.0.9", "172.16.0.0/12")).toBe(true);
    expect(isIpInCidr("::ffff:192.0.2.1", "172.16.0.0/12")).toBe(false);
  });

  it("handles compressed IPv6", () => {
    expect(isIpInCidr("fd12:3456::1", "fd12:3456::/48")).toBe(true);
    expect(isIpInCidr("fd12:34ff::1", "fd12:3456::/48")).toBe(false);
  });
});

describe("isTrustedProxy", () => {
  it("returns false for null", () => {
    expect(isTrustedProxy(null, ["127.0.0.1/32"])).toBe(false);
    expect(isTrustedProxy(null, [])).toBe(false);
  });

  it("checks all candidate CIDRs", () => {
    const cidrs = ["127.0.0.1/32", "172.16.0.0/12"];
    expect(isTrustedProxy("127.0.0.1", cidrs)).toBe(true);
    expect(isTrustedProxy("172.18.5.5", cidrs)).toBe(true);
    expect(isTrustedProxy("8.8.8.8", cidrs)).toBe(false);
  });
});

describe("extractClientIp", () => {
  const headers = (cf: string | null): Headers => {
    const h = new Headers();
    if (cf) h.set("cf-connecting-ip", cf);
    return h;
  };

  it("accepts CF-Connecting-IP only from trusted proxies", () => {
    const r = extractClientIp({
      remoteAddress: "172.18.0.2",
      headers: headers("203.0.113.9"),
      trustedProxyCidrs: ["172.16.0.0/12"],
    });
    expect(r.ip).toBe("203.0.113.9");
    expect(r.source).toBe("cf-connecting-ip");
  });

  it("ignores CF-Connecting-IP from untrusted sources", () => {
    const r = extractClientIp({
      remoteAddress: "203.0.113.50",
      headers: headers("8.8.8.8"),
      trustedProxyCidrs: ["172.16.0.0/12"],
    });
    expect(r.ip).toBe("203.0.113.50");
    expect(r.source).toBe("remote-address");
  });

  it("falls back to remote address without CF header", () => {
    const r = extractClientIp({
      remoteAddress: "172.18.0.2",
      headers: headers(null),
      trustedProxyCidrs: ["172.16.0.0/12"],
    });
    expect(r.ip).toBe("172.18.0.2");
  });

  it("returns unknown when no address is available", () => {
    const r = extractClientIp({
      remoteAddress: null,
      headers: headers("203.0.113.9"),
      trustedProxyCidrs: ["172.16.0.0/12"],
    });
    // テストハーネスでは remoteAddress が取れないので信頼せず unknown
    expect(r.ip).toBe(null);
    expect(r.source).toBe("unknown");
  });
});
