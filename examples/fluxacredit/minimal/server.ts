import http from "node:http";

function b64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function jsonB64url(obj: unknown): string {
  return b64url(JSON.stringify(obj));
}

const SERVER_PORT = 4022;

http
  .createServer(async (req, res) => {
    const url = `http://localhost:${SERVER_PORT}${req.url}`.replace(/\/$/, "");
    const ps = req.headers["payment-signature"] as string | undefined;

    if (!ps) {
      const paymentRequired = {
        x402Version: 2,
        resource: { url, description: "Paid crawl content", mimeType: "text/html" },
        accepts: [
          {
            scheme: "fluxacredit",
            network: "fluxa:monetize",
            amount: "25",
            asset: "FLUXA_CREDIT",
            payTo: "fluxa:facilitator:us-east-1",
            maxTimeoutSeconds: 60,
            extra: { id: "abc123", termsUrl: "https://example.com/terms" },
          },
        ],
      };
      res.writeHead(402, {
        "Content-Type": "application/json",
        "PAYMENT-REQUIRED": jsonB64url(paymentRequired),
      });
      res.end(JSON.stringify({ error: "Payment required" }));
      return;
    }

    const paymentPayload = JSON.parse(Buffer.from(ps, "base64url").toString("utf8"));
    // Inject three Web Bot Auth headers into extensions (Plan B)
    paymentPayload.extensions = {
      ...(paymentPayload.extensions || {}),
      "web-bot-auth": {
        signatureAgent: req.headers["signature-agent"],
        signatureInput: req.headers["signature-input"],
        signature: req.headers["signature"],
        paymentSignatureHeader: ps,
      },
    };

    // Verify
    const verifyResp = await fetch("http://localhost:4023/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentPayload,
        paymentRequirements: paymentPayload.accepted,
      }),
    });
    const verifyJson = await verifyResp.json();
    if (!verifyJson.isValid) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: verifyJson.invalidReason }));
      return;
    }

    // Settle
    const settleResp = await fetch("http://localhost:4023/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentPayload,
        paymentRequirements: paymentPayload.accepted,
      }),
    });
    const settleJson = await settleResp.json();

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "PAYMENT-RESPONSE": jsonB64url({
        scheme: "fluxacredit",
        network: "fluxa:monetize",
        id: paymentPayload.accepted.extra?.id,
        chargedCredits: paymentPayload.accepted.amount,
        timestamp: Math.floor(Date.now() / 1000),
      }),
    });
    res.end(`<h1>hello paid content</h1><pre>${JSON.stringify(settleJson)}</pre>`);
  })
  .listen(SERVER_PORT, () => {
    console.log(`server listening on http://localhost:${SERVER_PORT}`);
  });
