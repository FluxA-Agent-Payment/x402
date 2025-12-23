import http from "node:http";

const PORT = 4023;

http
  .createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};

    if (req.method === "POST" && req.url === "/verify") {
      const { paymentPayload, paymentRequirements } = body;
      const wba = paymentPayload?.extensions?.["web-bot-auth"] || {};
      const okReq = JSON.stringify(paymentPayload?.accepted) === JSON.stringify(paymentRequirements);
      const coversPaymentHeader = String(wba?.signatureInput || "").includes('"payment-signature"');
      const hasAgent = typeof wba?.signatureAgent === "string" && String(wba.signatureAgent).startsWith('"https://');
      const isValid = okReq && coversPaymentHeader && hasAgent;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ isValid, invalidReason: isValid ? undefined : "invalid_web_bot_auth" }));
      return;
    }

    if (req.method === "POST" && req.url === "/settle") {
      const { paymentRequirements } = body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          transaction: `credit-ledger:${paymentRequirements?.extra?.id}`,
          network: paymentRequirements?.network || "fluxa:monetize",
        }),
      );
      return;
    }

    res.writeHead(404).end();
  })
  .listen(PORT, () => {
    console.log(`facilitator listening on http://localhost:${PORT}`);
  });

