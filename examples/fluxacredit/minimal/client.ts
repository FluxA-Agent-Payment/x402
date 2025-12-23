import http from "node:http";

function b64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function decodeRequired(header: string) {
  return JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
}

function request(opts: http.RequestOptions, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise(resolve => {
    const req = http.request(opts, res => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(c as Buffer));
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const host = "localhost";
  const port = 4022;
  const path = "/protected.html";

  // Step 1: discovery
  const r1 = await request({ host, port, path, method: "GET" });
  console.log("STEP1 status=", r1.status);
  const requiredHeader = r1.headers["payment-required"] as string;
  const paymentRequired = decodeRequired(requiredHeader);
  const accepted = paymentRequired.accepts[0];

  // Step 2: build payment payload
  const paymentPayload = {
    x402Version: 2,
    resource: { url: `http://${host}:${port}${path}` },
    accepted,
    payload: {
      signature: "http-message-signatures",
      "signature-fluxa-ai-agent-id": "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U",
      challengeId: accepted.extra.id,
    },
  };
  const paymentSignature = b64url(JSON.stringify(paymentPayload));

  // Fake HTTP message signatures headers (demo only); ensure we include "payment-signature"
  const signatureAgent = '"https://crawler.example/.well-known/http-message-signatures-directory"';
  const signatureInput = 'sig1=("payment-signature" "signature-agent" "@authority");created=1735689600;expires=1735693200;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";nonce="...";tag="web-bot-auth"';
  const signature = "sig1=:demo-signature:";

  // Step 3: retry with headers
  const r2 = await request({ host, port, path, method: "GET", headers: {
    "PAYMENT-SIGNATURE": paymentSignature,
    "Signature-Agent": signatureAgent,
    "Signature-Input": signatureInput,
    "Signature": signature,
  }});

  console.log("STEP2 status=", r2.status);
  console.log("PAYMENT-RESPONSE=", r2.headers["payment-response"]);
}

main().catch(e => { console.error(e); process.exit(1); });

