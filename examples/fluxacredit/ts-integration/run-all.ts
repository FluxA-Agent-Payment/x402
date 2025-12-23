import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { FluxaCreditClientScheme } from "@x402/fluxa/credit/client";
import { FluxaCreditServerScheme } from "@x402/fluxa/credit/server";
import { FluxaCreditFacilitatorScheme } from "@x402/fluxa/credit/facilitator";
// Third-party HTTP Message Signatures helper (placeholder API; adjust to actual library)
import * as WBA from "web-bot-auth";

function b64url(data: string) { return Buffer.from(data).toString("base64url"); }
function jsonB64url(obj: unknown) { return b64url(JSON.stringify(obj)); }
function log(scope: string, msg: string, obj?: any) {
  const ts = new Date().toISOString().split("T")[1]?.replace("Z", "") || "";
  if (obj !== undefined) {
    console.log(`[${ts}] [${scope}] ${msg}:`, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
  } else {
    console.log(`[${ts}] [${scope}] ${msg}`);
  }
}

// --- 1) JWKS directory ---
function genEd25519Jwk() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" }) as any; // { kty:'OKP', crv:'Ed25519', x:'base64url' }
  const thumbSrc = JSON.stringify({ crv: pubJwk.crv, kty: pubJwk.kty, x: pubJwk.x });
  const thumb = crypto.createHash("sha256").update(thumbSrc).digest("base64url");
  return { publicKey, privateKey, pubJwk, thumb };
}

async function startJwksDirectory(port: number, jwk: { x: string }) {
  const path = "/.well-known/http-message-signatures-directory";
  const server = http.createServer((req, res) => {
    log("JWKS", "request", { method: req.method, url: req.url, headers: req.headers });
    if (req.url === path) {
      res.writeHead(200, { "Content-Type": "application/http-message-signatures-directory+json" });
      const body = { keys: [{ kty: "OKP", crv: "Ed25519", x: jwk.x }] };
      log("JWKS", "respond 200", body);
      res.end(JSON.stringify(body));
    } else {
      log("JWKS", "respond 404");
      res.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(port, resolve));
  console.log(`[JWKS] http://localhost:${port}${path}`);
  return { server, signatureAgent: `"http://localhost:${port}${path}"` };
}

// --- 2) Facilitator over HTTP using x402Facilitator + FluxaCreditFacilitatorScheme ---
async function startFacilitator(port: number) {
  const fac = new x402Facilitator();
  fac.register("fluxa:monetize" as any, new FluxaCreditFacilitatorScheme());

  const server = http.createServer(async (req, res) => {
    log("FACILITATOR", "request", { method: req.method, url: req.url, headers: req.headers });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    try {
      if (req.method === "POST" && req.url === "/verify") {
        const { paymentPayload, paymentRequirements } = body as { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
        log("FACILITATOR", "verify input.paymentPayload", paymentPayload);
        log("FACILITATOR", "verify input.paymentRequirements", paymentRequirements);
        const out = await fac.verify(paymentPayload, paymentRequirements);
        log("FACILITATOR", "verify result", out);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
        return;
      }
      if (req.method === "POST" && req.url === "/settle") {
        const { paymentPayload, paymentRequirements } = body as { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
        log("FACILITATOR", "settle input.paymentPayload", paymentPayload);
        log("FACILITATOR", "settle input.paymentRequirements", paymentRequirements);
        const out = await fac.settle(paymentPayload, paymentRequirements);
        log("FACILITATOR", "settle result", out);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
        return;
      }
      if (req.method === "GET" && req.url === "/supported") {
        const out = fac.getSupported();
        log("FACILITATOR", "supported", out);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
        return;
      }
    } catch (e: any) {
      log("FACILITATOR", "error", { message: String(e?.message || e), stack: e?.stack });
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e?.message || e) }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(port, resolve));
  console.log(`[FACILITATOR] http://localhost:${port}`);
  return { server };
}

// --- 3) Resource server (pure http) ---
async function startResourceServer(port: number) {
  const serverScheme = new FluxaCreditServerScheme();
  const server = http.createServer(async (req, res) => {
    const fullUrl = `http://localhost:${port}${req.url}`;
    const ps = req.headers["payment-signature"] as string | undefined;
    log("SERVER", "request", { method: req.method, url: req.url, hasPaymentSignature: !!ps, headers: req.headers });
    if (!ps) {
      // precise price offer
      const base = await serverScheme.parsePrice("25", "fluxa:monetize" as any);
      const accepted: PaymentRequirements = {
        scheme: "fluxacredit",
        network: "fluxa:monetize" as any,
        amount: base.amount,
        asset: base.asset,
        payTo: "fluxa:facilitator:us-east-1",
        maxTimeoutSeconds: 60,
        extra: { id: "abc123", termsUrl: "https://example.com/terms" },
      };
      const paymentRequired = {
        x402Version: 2,
        resource: { url: fullUrl, description: "Paid crawl content", mimeType: "text/html" },
        accepts: [accepted],
      };
      const prh = encodePaymentRequiredHeader(paymentRequired as any);
      log("SERVER", "respond 402 PAYMENT-REQUIRED (decoded)", paymentRequired);
      res.writeHead(402, { "Content-Type": "application/json", "PAYMENT-REQUIRED": prh });
      res.end(JSON.stringify({ error: "Payment required" }));
      return;
    }

    // Inject Web Bot Auth headers into extensions and forward to facilitator
    const paymentPayload = JSON.parse(Buffer.from(ps, "base64url").toString("utf8")) as PaymentPayload;
    log("SERVER", "received PAYMENT-SIGNATURE (decoded paymentPayload)", paymentPayload);
    (paymentPayload as any).extensions = {
      ...((paymentPayload as any).extensions || {}),
      "web-bot-auth": {
        signatureAgent: req.headers["signature-agent"],
        signatureInput: req.headers["signature-input"],
        signature: req.headers["signature"],
        paymentSignatureHeader: ps,
      },
    };
    log("SERVER", "augmented paymentPayload.extensions.web-bot-auth", (paymentPayload as any).extensions?.["web-bot-auth"]);

    const verifyResp = await fetch("http://localhost:4023/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentPayload, paymentRequirements: paymentPayload.accepted }),
    }).then(r => r.json());
    log("SERVER", "verify response", verifyResp);

    if (!verifyResp.isValid) {
      log("SERVER", "verification failed", verifyResp);
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: verifyResp.invalidReason }));
      return;
    }

    const settle = await fetch("http://localhost:4023/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentPayload, paymentRequirements: paymentPayload.accepted }),
    }).then(r => r.json());
    log("SERVER", "settle result", settle);

    const paymentResponseHeader = encodePaymentResponseHeader({ ...(settle as any), requirements: paymentPayload.accepted });

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "PAYMENT-RESPONSE": paymentResponseHeader,
    });
    log("SERVER", "respond 200 with PAYMENT-RESPONSE (raw)", paymentResponseHeader);
    res.end(`<h1>hello paid content</h1>\n<pre>${JSON.stringify(settle)}</pre>`);
  });
  await new Promise<void>(resolve => server.listen(port, resolve));
  console.log(`[SERVER] http://localhost:${port}`);
  return { server };
}

// --- 4) Client using x402 packages + third-party HTTP Message Signatures (web-bot-auth) ---
async function runClient({ serverPort, signatureAgent, privateKey, thumb }: { serverPort: number; signatureAgent: string; privateKey: crypto.KeyObject; thumb: string }) {
  const client = new x402Client();
  client.register("fluxa:monetize" as any, new FluxaCreditClientScheme());
  const httpClient = new x402HTTPClient(client);

  function req(opts: http.RequestOptions, body?: string) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>(resolve => {
      const r = http.request(opts, res => {
        const chunks: Buffer[] = [];
        res.on("data", c => chunks.push(c as Buffer));
        res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      });
      if (body) r.write(body);
      r.end();
    });
  }

  const path = "/protected.html";
  const r1 = await req({ host: "localhost", port: serverPort, path, method: "GET" });
  console.log("[CLIENT] step1 status=", r1.status);
  log("CLIENT", "step1 response headers", r1.headers);
  const required = JSON.parse(Buffer.from(String(r1.headers["payment-required"]), "base64url").toString("utf8"));
  log("CLIENT", "decoded PAYMENT-REQUIRED", required);

  const paymentPayload = await client.createPaymentPayload(required);
  log("CLIENT", "created paymentPayload", paymentPayload);
  const headers = httpClient.encodePaymentSignatureHeader(paymentPayload);
  log("CLIENT", "encoded PAYMENT-SIGNATURE header", headers);
  const paymentSignature = headers["PAYMENT-SIGNATURE"];

  // Build Signature-Input & Signature with third-party package (placeholder API)
  const created = Math.floor(Date.now() / 1000);
  const expires = created + 60;
  const signatureInput = (WBA as any).createSignatureInput?.({
    label: "sig1",
    components: ["payment-signature", "signature-agent", "@authority"],
    params: { created, expires, keyid: thumb, alg: "ed25519", nonce: "demo", tag: "web-bot-auth" },
  }) || `sig1=("payment-signature" "signature-agent" "@authority");created=${created};expires=${expires};keyid="${thumb}";alg="ed25519";nonce="demo";tag="web-bot-auth"`;

  // Third-party signer; fallback to Node crypto if not available
  const u = new URL(`http://localhost:${serverPort}${path}`);
  const authority = u.host;
  let signature: string;
  if ((WBA as any).sign) {
    signature = await (WBA as any).sign({
      signatureInput,
      headers: { "payment-signature": paymentSignature, "signature-agent": signatureAgent },
      method: "GET",
      url: u.toString(),
      privateKeyJwk: privateKey.export({ format: "jwk" }),
    });
  } else {
    // manual base compatible with facilitator impl in this repo
    const label = signatureInput.slice(0, signatureInput.indexOf("="));
    const rawParams = signatureInput.slice(signatureInput.indexOf("("));
    const base = [`"payment-signature": ${paymentSignature}`, `"signature-agent": ${signatureAgent}`, `"@authority": ${authority}`, `"@signature-params": ${rawParams}`].join("\n");
    const sigBuf = crypto.sign(null, Buffer.from(base, "utf8"), privateKey);
    signature = `${label}=:${sigBuf.toString("base64")}:`;
  }
  log("CLIENT", "Signature-Input", signatureInput);
  log("CLIENT", "Signature", signature);

  const r2 = await req({ host: "localhost", port: serverPort, path, method: "GET", headers: {
    "PAYMENT-SIGNATURE": paymentSignature,
    "Signature-Agent": signatureAgent,
    "Signature-Input": signatureInput,
    "Signature": signature,
  }});
  console.log("[CLIENT] step2 status=", r2.status);
  log("CLIENT", "step2 response headers", r2.headers);
  console.log("[CLIENT] payment-response=", r2.headers["payment-response"]);
  try {
    const settleResp = new x402HTTPClient(new x402Client()).getPaymentSettleResponse((name) => r2.headers[name.toLowerCase()] as string | undefined);
    log("CLIENT", "decoded PAYMENT-RESPONSE", settleResp);
  } catch (e: any) {
    log("CLIENT", "failed to decode PAYMENT-RESPONSE", { message: String(e?.message || e) });
  }
}

// --- Orchestration ---
(async () => {
  const key = genEd25519Jwk();
  const jwks = await startJwksDirectory(5052, key.pubJwk);
  const facilitator = await startFacilitator(4023);
  const server = await startResourceServer(4024);
  try {
    await runClient({ serverPort: 4024, signatureAgent: jwks.signatureAgent, privateKey: key.privateKey, thumb: key.thumb });
  } catch (e) {
    console.error("[RUN ERROR]", e);
  } finally {
    setTimeout(() => { (server.server as any)?.close?.(); (facilitator.server as any)?.close?.(); (jwks.server as any)?.close?.(); }, 500);
  }
})();
