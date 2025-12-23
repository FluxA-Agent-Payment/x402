import nacl from "tweetnacl";
import { createHash } from "node:crypto";

export type VerifyInput = {
  signatureAgent: string; // as received in header (may include quotes)
  signatureInput: string; // e.g., sig1=("payment-signature" "signature-agent" "@authority");created=...;expires=...;keyid="...";alg="ed25519";nonce="...";tag="web-bot-auth"
  signature: string; // e.g., sig1=:BASE64SIG:
  method: string; // e.g., GET
  url: string; // full URL
  paymentSignatureHeader: string; // raw PAYMENT-SIGNATURE header value (base64url JSON)
};

export type VerifyResult = { ok: boolean; thumbprint?: string; error?: string };

type ParsedSigInput = {
  label: string; // sig1
  components: string[]; // ["payment-signature", "signature-agent", "@authority"]
  params: Record<string, string> & { created?: string; expires?: string };
  rawParamsSection: string; // the substring like ("...");created=...;expires=...
};

function parseSignatureInput(input: string): ParsedSigInput {
  // Example: sig1=("payment-signature" "signature-agent" "@authority");created=...;expires=...;keyid="...";alg="ed25519";nonce="...";tag="web-bot-auth"
  const idx = input.indexOf("=");
  if (idx === -1) throw new Error("invalid_signature_input");
  const label = input.slice(0, idx).trim();
  const rest = input.slice(idx + 1).trim();
  // rest should start with (
  const open = rest.indexOf("(");
  const close = rest.indexOf(")");
  if (open === -1 || close === -1 || close < open) throw new Error("invalid_signature_input_components");
  const compStr = rest.slice(open + 1, close).trim();
  const rawParamsSection = rest.slice(open, rest.length).trim();
  // split components by space, respecting quoted strings
  const comps: string[] = [];
  let i = 0;
  while (i < compStr.length) {
    while (i < compStr.length && compStr[i] === " ") i++;
    if (i >= compStr.length) break;
    if (compStr[i] === '"') {
      const j = compStr.indexOf('"', i + 1);
      if (j === -1) throw new Error("invalid_signature_input_components_quote");
      comps.push(compStr.slice(i + 1, j));
      i = j + 1;
    } else if (compStr[i] === "@") {
      // derived component without quotes
      const j = compStr.indexOf(" ", i);
      const end = j === -1 ? compStr.length : j;
      comps.push(compStr.slice(i, end));
      i = end;
    } else {
      // token
      const j = compStr.indexOf(" ", i);
      const end = j === -1 ? compStr.length : j;
      comps.push(compStr.slice(i, end));
      i = end;
    }
  }
  // parse params after ')'
  const paramStr = rest.slice(close + 1).trim();
  const params: Record<string, string> = {};
  const parts = paramStr.split(";").map(s => s.trim()).filter(Boolean);
  for (const p of parts) {
    const ei = p.indexOf("=");
    if (ei === -1) continue;
    const k = p.slice(0, ei).trim();
    let v = p.slice(ei + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }
  return { label, components: comps, params, rawParamsSection };
}

function base64urlToBytes(s: string): Uint8Array {
  // s may contain '-' '_' variant; Buffer supports base64url if we replace
  return new Uint8Array(Buffer.from(s, "base64url"));
}

function base64ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

async function fetchJwks(signatureAgent: string): Promise<any> {
  const url = signatureAgent.startsWith('"') && signatureAgent.endsWith('"')
    ? signatureAgent.slice(1, -1)
    : signatureAgent;
  const res = await fetch(url, { headers: { Accept: "application/http-message-signatures-directory+json, application/json" } });
  if (!res.ok) throw new Error(`jwks_fetch_failed:${res.status}`);
  return await res.json();
}

function jwkThumbprintEd25519(jwk: { kty: string; crv: string; x: string }): string {
  // RFC 7638 / RFC 8037 A.3 (OKP): members: crv, kty, x
  const obj = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  const json = JSON.stringify(obj);
  const digest = createHash("sha256").update(json).digest();
  return Buffer.from(digest).toString("base64url");
}

function buildSignatureBase(parsed: ParsedSigInput, headers: { [k: string]: string }, authority: string): Uint8Array {
  // Very small subset base construction for components we require.
  const lines: string[] = [];
  for (const c of parsed.components) {
    if (c === "@authority") {
      lines.push(`"@authority": ${authority}`);
    } else {
      const name = c.toLowerCase();
      const val = headers[name];
      if (val === undefined) throw new Error(`missing_header:${name}`);
      lines.push(`"${name}": ${val}`);
    }
  }
  lines.push(`"@signature-params": ${parsed.rawParamsSection}`);
  return new TextEncoder().encode(lines.join("\n"));
}

function parseSignatureHeader(signature: string): { label: string; sig: Uint8Array } {
  // Example: sig1=:BASE64SIG:
  const idx = signature.indexOf("=");
  if (idx === -1) throw new Error("invalid_signature_header");
  const label = signature.slice(0, idx).trim();
  const rest = signature.slice(idx + 1).trim();
  const m = rest.match(/^:([A-Za-z0-9+/=]+):$/);
  if (!m) throw new Error("invalid_signature_value");
  const sig = base64ToBytes(m[1]);
  return { label, sig };
}

export async function verifyWebBotAuth(input: VerifyInput): Promise<VerifyResult> {
  try {
    const parsed = parseSignatureInput(String(input.signatureInput || ""));
    if (parsed.params["tag"] !== "web-bot-auth") return { ok: false, error: "invalid_tag" };
    if (!parsed.components.includes("payment-signature")) return { ok: false, error: "missing_component_payment-signature" };
    if (!parsed.components.includes("signature-agent")) return { ok: false, error: "missing_component_signature-agent" };
    if (!parsed.components.includes("@authority")) return { ok: false, error: "missing_component_@authority" };

    const { label, sig } = parseSignatureHeader(String(input.signature || ""));
    if (label !== parsed.label) return { ok: false, error: "label_mismatch" };

    // Enforce short-lived window
    const created = parsed.params["created"] ? parseInt(parsed.params["created"], 10) : undefined;
    const expires = parsed.params["expires"] ? parseInt(parsed.params["expires"], 10) : undefined;
    if (created && expires) {
      const now = Math.floor(Date.now() / 1000);
      if (expires - created > 60) return { ok: false, error: "window_too_long" };
      if (now < created - 60 || now > expires + 60) return { ok: false, error: "expired_or_not_yet_valid" };
    }

    const u = new URL(input.url);
    const authority = u.host; // includes port if present

    // Build a mini header map for signed fields
    const signedHeaders: Record<string, string> = {
      "payment-signature": input.paymentSignatureHeader,
      "signature-agent": input.signatureAgent,
    };
    const base = buildSignatureBase(parsed, signedHeaders, authority);

    // Fetch JWKS and find key by thumbprint == keyid
    const jwks = await fetchJwks(String(input.signatureAgent || ""));
    const keys: Array<{ kty: string; crv: string; x: string }> = jwks?.keys || [];
    const keyid = parsed.params["keyid"];
    let pub: Uint8Array | null = null;
    for (const k of keys) {
      if (k.kty !== "OKP" || k.crv !== "Ed25519" || !k.x) continue;
      const thumb = jwkThumbprintEd25519(k);
      if (thumb === keyid) {
        pub = base64urlToBytes(k.x);
        break;
      }
    }
    if (!pub) return { ok: false, error: "key_not_found" };

    const ok = nacl.sign.detached.verify(base, sig, pub);
    return ok ? { ok: true, thumbprint: keyid } : { ok: false, error: "signature_verify_failed" };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
