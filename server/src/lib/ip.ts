/**
 * クライアントIPの抽出。
 *
 * - Cloudflare Tunnel 経由なので、リクエスト元が信頼できるプロキシ(CIDR一致)の場合のみ
 *   CF-Connecting-IP ヘッダーを採用する。
 * - それ以外のリクエスト元から送られた CF-Connecting-IP は偽装の可能性があるため無視し、
 *   実接続先アドレスを代わりに使う(はない場合は null)。
 *
 * IPはレート制限の判定だけに使い、レビュー・レポートの記録と紐づけて永続保存しない。
 */

const IPV4_CIDR = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/;
const IPV6_CIDR = /^([0-9a-fA-F:]+)\/(\d{1,3})$/;

function ipv4ToBits(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bits: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    for (let i = 7; i >= 0; i--) bits.push((n >> i) & 1);
  }
  return bits;
}

/** IPv6を8組の16ビット倍精度数に展開する (:: 圧縮に対応) */
function ipv6ToGroups(ip: string): number[] | null {
  if (!ip.includes(":")) return null;
  let head = ip;
  const v4Match = ip.match(/^((?:[0-9a-fA-F:]+):)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Match) {
    // IPv4終端 (::ffff:192.0.2.1 など) を2組の16進グループに変換する
    const prefixPart = v4Match[1];
    const v4Part = v4Match[2];
    if (prefixPart === undefined || v4Part === undefined) return null;
    const quads = v4Part.split(".").map(Number);
    if (quads.length !== 4 || !quads.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      return null;
    }
    const [a, b, c, d] = quads as [number, number, number, number];
    head = `${prefixPart}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const doubleColon = head.split("::");
  if (doubleColon.length > 2) return null;
  const leftParts = doubleColon[0] ? doubleColon[0].split(":").filter(Boolean) : [];
  const rightParts =
    doubleColon.length === 2 && doubleColon[1]
      ? doubleColon[1].split(":").filter(Boolean)
      : [];
  const missing = 8 - (leftParts.length + rightParts.length);
  if (missing < 0) return null;
  if (doubleColon.length === 1 && missing !== 0) return null;
  const groups: number[] = [];
  for (const part of [...leftParts, ...Array(missing).fill("0"), ...rightParts]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  if (groups.length !== 8) return null;
  const bits: number[] = [];
  for (const g of groups) for (let i = 15; i >= 0; i--) bits.push((g >> i) & 1);
  return bits;
}

/** CIDR(例: 172.16.0.0/12, ::1/128) に ip が含まれるか */
export function isIpInCidr(ip: string, cidr: string): boolean {
  const cleaned = ip.replace(/^::ffff:/, ""); // IPv4-mapped IPv6 を IPv4 として扱う
  const v4 = IPV4_CIDR.exec(cidr);
  if (v4) {
    const ipBits = ipv4ToBits(cleaned);
    if (!ipBits) return false;
    const cidrIp = v4[1];
    if (cidrIp === undefined) return false;
    const prefixBits = ipv4ToBits(cidrIp);
    if (!prefixBits) return false;
    const prefix = Number(v4[2]);
    if (prefix < 0 || prefix > 32) return false;
    for (let i = 0; i < prefix; i++) {
      if ((ipBits[i] ?? 0) !== (prefixBits[i] ?? 0)) return false;
    }
    return true;
  }
  const v6 = IPV6_CIDR.exec(cidr);
  if (v6) {
    const ipBits = ipv6ToGroups(cleaned);
    if (!ipBits) return false;
    const cidrIp = v6[1];
    if (cidrIp === undefined) return false;
    const cidrBits = ipv6ToGroups(cidrIp);
    if (!cidrBits) return false;
    const prefix = Number(v6[2]);
    if (prefix < 0 || prefix > 128) return false;
    for (let i = 0; i < prefix; i++) {
      if ((ipBits[i] ?? 0) !== (cidrBits[i] ?? 0)) return false;
    }
    return true;
  }
  return false;
}

export function isTrustedProxy(ip: string | null, cidrs: readonly string[]): boolean {
  if (!ip) return false;
  return cidrs.some((cidr) => isIpInCidr(ip, cidr));
}

export type ClientIpSource = "cf-connecting-ip" | "remote-address" | "unknown";

/**
 * レビュー/レポートの_authorization 以外のことをしないため、
 * ここでのみクライアントIPを確定する。
 */
export function extractClientIp(args: {
  remoteAddress: string | null;
  headers: Headers;
  trustedProxyCidrs: readonly string[];
}): { ip: string | null; source: ClientIpSource } {
  const { remoteAddress, headers, trustedProxyCidrs } = args;
  const cfIp = headers.get("cf-connecting-ip");
  if (cfIp && isTrustedProxy(remoteAddress, trustedProxyCidrs)) {
    return { ip: cfIp.trim(), source: "cf-connecting-ip" };
  }
  if (remoteAddress) return { ip: remoteAddress, source: "remote-address" };
  return { ip: null, source: "unknown" };
}
