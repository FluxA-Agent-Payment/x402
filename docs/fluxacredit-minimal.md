# FluxAcredit (Plan B) — Minimal, Framework‑Agnostic Guide

本指南演示如何在不改动 x402 v2 核心类型的前提下，集成 `fluxacredit` 精确定价方案（Web Bot Auth 身份 + 精确 credits 扣费）。采用方案 B：由“资源服务器”在调用 Facilitator 前，将 HTTP Web Bot Auth 三个头部原文注入到 `PaymentPayload.extensions["web-bot-auth"]`，从而使 Facilitator 能独立校验身份与签名覆盖。

要点
- 精确价格：服务端在 402 中返回确切的 credit 数量（不是预授权）。
- 身份：客户端通过 Web Bot Auth（HTTP Message Signatures）签名请求，且签名必须覆盖 `payment-signature` 头（绑定身份与 x402 JSON）。
- 不改 Core：只使用 `PaymentRequirements.extra`、`PaymentPayload.payload`、`PaymentPayload.extensions` 传递上下文。

---

## 1) Client（最小实现）
伪代码（任意 HTTP 客户端均可，示例为 Node/fetch 风格）：

```ts
// Step 1: 请求资源，收到 402（从 PAYMENT-REQUIRED 头或 JSON 体解析 PaymentRequired）
const r1 = await fetch(url);
if (r1.status === 402) {
  const requiredHeader = r1.headers.get('PAYMENT-REQUIRED');
  const paymentRequired = decodePaymentRequired(requiredHeader); // 自行实现或复用工具
  const accepted = paymentRequired.accepts.find(a => a.scheme === 'fluxacredit');

  // Step 2: 构造 PaymentPayload（v2）
  const paymentPayload = {
    x402Version: 2,
    resource: { url },
    accepted,
    payload: {
      signature: 'http-message-signatures',
      'signature-fluxa-ai-agent-id': '<agent_or_thumbprint>',
      challengeId: accepted.extra.id,
    },
    // 可选：也可直接在客户端把三签名头写到 extensions 中（方案 B 允许服务端注入或客户端提供）
    // extensions: { 'web-bot-auth': { signatureAgent, signatureInput, signature } }
  };

  // Step 3: 生成 PAYMENT-SIGNATURE 头（Base64URL(JSON)）
  const paymentSignature = base64url(JSON.stringify(paymentPayload));

  // Step 4: 生成 Web Bot Auth 头，且 Signature-Input 必须覆盖 "payment-signature"
  const signatureAgent = '"https://crawler.example/.well-known/http-message-signatures-directory"';
  const signatureInput =
    'sig1=("payment-signature" "signature-agent" "@authority");' +
    'created=1735689600;expires=1735693200;keyid="<thumbprint>";alg="ed25519";nonce="...";tag="web-bot-auth"';
  const signature = await signHttpMessage({
    method: 'GET', url, headers: {
      'payment-signature': paymentSignature,
      'signature-agent': signatureAgent
    } , signatureInput
  });

  // Step 5: 重试请求
  const r2 = await fetch(url, {
    headers: {
      'PAYMENT-SIGNATURE': paymentSignature,
      'Signature-Agent': signatureAgent,
      'Signature-Input': signatureInput,
      'Signature': signature,
    }
  });
}
```

---

## 2) Server（最小实现）
关键点：
- 首次请求无支付 → 返回 402 + `PAYMENT-REQUIRED`，其中 `accepts[*]` 的 `amount` 为精确扣费 credits，`extra.id` 为挑战 id。
- 重试请求有 `PAYMENT-SIGNATURE` + 三个签名头 → 解析 PaymentPayload，并把三签名头注入 `paymentPayload.extensions['web-bot-auth']` 再调用 Facilitator `/verify`。
- 验证通过后调用 `/settle`，返回 200 并附带 `PAYMENT-RESPONSE`。

伪代码：
```ts
import http from 'node:http';

http.createServer(async (req, res) => {
  const url = `https://example.com${req.url}`;

  // 读取支付头
  const ps = req.headers['payment-signature'] as string | undefined;
  if (!ps) {
    // 构造 PaymentRequired（精确价格）
    const paymentRequired = {
      x402Version: 2,
      resource: { url, description: 'Paid crawl content', mimeType: 'text/html' },
      accepts: [{
        scheme: 'fluxacredit',
        network: 'fluxa:monetize',
        amount: '25',
        asset: 'FLUXA_CREDIT',
        payTo: 'fluxa:facilitator:us-east-1',
        maxTimeoutSeconds: 60,
        extra: { id: 'abc123', termsUrl: 'https://example.com/terms' }
      }]
    };
    res.writeHead(402, {
      'Content-Type': 'application/json',
      'PAYMENT-REQUIRED': base64url(JSON.stringify(paymentRequired))
    });
    return res.end(JSON.stringify({ error: 'Payment required' }));
  }

  // 解码 PaymentPayload
  const paymentPayload = JSON.parse(base64urlDecode(ps));

  // 方案 B：把三签名头注入 extensions 供 Facilitator 校验（建议同时注入原始 PAYMENT-SIGNATURE 头值）
  paymentPayload.extensions = {
    ...(paymentPayload.extensions || {}),
    'web-bot-auth': {
      signatureAgent: req.headers['signature-agent'],
      signatureInput: req.headers['signature-input'],
      signature: req.headers['signature'],
      paymentSignatureHeader: ps
    }
  };

  // 调用 Facilitator /verify
  const verifyResp = await fetch('http://localhost:4023/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentPayload, paymentRequirements: paymentPayload.accepted })
  }).then(r => r.json());

  if (!verifyResp.isValid) {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: verifyResp.invalidReason }));
  }

  // 结算（精确扣费）
  const settle = await fetch('http://localhost:4023/settle', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentPayload, paymentRequirements: paymentPayload.accepted })
  }).then(r => r.json());

  // 返回资源与 PAYMENT-RESPONSE
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'PAYMENT-RESPONSE': base64url(JSON.stringify({
      scheme: 'fluxacredit', network: 'fluxa:monetize', id: paymentPayload.accepted.extra.id,
      chargedCredits: paymentPayload.accepted.amount, timestamp: Math.floor(Date.now()/1000)
    }))
  });
  res.end('<h1>Hello, paid content</h1>');
}).listen(4022);
```

---

## 3) Facilitator（最小实现）
- `/verify`：
  - 校验 `accepted` 与 402 下发一致（amount/asset/payTo/extra.id）。
  - 从 `paymentPayload.extensions['web-bot-auth']` 取 `signatureAgent/signatureInput/signature`，按 Web Bot Auth 验签（需包含组件 `"payment-signature"`），校验 `resource.url` 的 authority 与 `@authority` 一致。
  - 返回 `{ isValid: true, payer: <thumbprint_or_agent> }` 或 `{ isValid:false, invalidReason }`。
- `/settle`：精确扣账 `accepted.amount`，返回 `{ success:true, transaction:"credit-ledger:<id>", network:"fluxa:monetize" }`。

伪代码：
```ts
import http from 'node:http';

const ledger = new Map<string, number>(); // mock balance by thumbprint

http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');

  if (req.url === '/verify' && req.method === 'POST') {
    const { paymentPayload, paymentRequirements } = body;
    const ext = paymentPayload.extensions?.['web-bot-auth'] || {};

    // 1) 基础匹配
    const okReq = JSON.stringify(paymentPayload.accepted) === JSON.stringify(paymentRequirements);

    // 2) Web Bot Auth 验签（此处示意：真实实现需按 RFC 9421 与目录草案校验）
    const coversPaymentHeader = String(ext.signatureInput || '').includes('"payment-signature"');
    const hasAgent = typeof ext.signatureAgent === 'string' && String(ext.signatureAgent).startsWith('"https://');

    const isValid = okReq && coversPaymentHeader && hasAgent;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ isValid, invalidReason: isValid ? undefined : 'invalid_web_bot_auth' }));
  }

  if (req.url === '/settle' && req.method === 'POST') {
    const { paymentPayload, paymentRequirements } = body;
    const amount = Number(paymentRequirements.amount);
    // mock 扣账成功
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      transaction: `credit-ledger:${paymentRequirements.extra.id}`,
      network: 'fluxa:monetize'
    }));
  }

  res.writeHead(404).end();
}).listen(4023);
```

---

## 常见注意事项
- Signature-Input 必须包含 `"payment-signature"`，否则无法将身份与支付 JSON 绑定。
- `accepted.amount` 是精确扣费（credits），不是预授权；`extra.id` 作为幂等键，重复结算不得二次扣款。
- 生产环境应使用 Cloudflare 的 web-bot-auth 库或等效实现对 HTTP Message Signatures 与目录签名进行严格校验。
- 服务端可选择把三签名头注入 `extensions['web-bot-auth']`（方案 B），或要求客户端直接附带在 extensions 中。
