# Scheme: `fluxacredit` on `fluxa:monetize`

## Summary
`fluxacredit` is an x402 v2 scheme that charges FluxA Monetize credits for access to HTTP resources using an exact, server-quoted price. Identity is proven via Web Bot Auth (HTTP Message Signatures). The PaymentPayload is carried in the `PAYMENT-SIGNATURE` header, and the bot’s HTTP signature MUST cover that header to bind identity to the payment JSON. No “intent/hold” flow is used; the server returns an exact price and the facilitator debits that amount upon settlement.

— Identity: clients MUST send `Signature-Agent`, `Signature-Input` (with `tag="web-bot-auth"`), and `Signature`.
— Pricing: exact price in credits; no usage-based post-adjustment.
— Flow: server/CDN returns 402 with a fixed credit amount → client retries with `PAYMENT-SIGNATURE` containing the payment JSON → bot’s HTTP signature covers `payment-signature` → facilitator verifies and debits the exact amount.

---

## PaymentRequired (server → client)
The top-level `PaymentRequired` includes the resource being protected and an `accepts[*]` entry for `fluxacredit` with an exact credit price:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://example.com/protected.html",
    "description": "Paid crawl content",
    "mimeType": "text/html"
  },
  "accepts": [
    {
      "scheme": "fluxacredit",
      "network": "fluxa:monetize",
      "amount": "25",                  
      "asset": "FLUXA_CREDIT",
      "payTo": "fluxa:facilitator:us-east-1",
      "maxTimeoutSeconds": 60,
      "extra": {
        "id": "1735689600-b4d2e1f0-7f2a-4e6c-9c1b-4b3a2c1d5e0f",  
        "termsUrl": "https://example.com/terms"
      }
    }
  ]
}
```

Field notes
- `amount` is the exact charge in credits to be debited (not a hold).
- `asset = FLUXA_CREDIT` identifies Monetize credit units.
- `extra.id` is a unique challenge identifier (time-based nonce) used for idempotency and replay protection.

---

## PaymentPayload (client → server)
The client retries the request and includes the following JSON via HTTP `PAYMENT-SIGNATURE`. Because Web Bot Auth signs headers (including the payment header), the payload only contains identity hints; the facilitator reads the HTTP `Signature` and `Signature-Input` headers to verify identity.

```json
{
  "x402Version": 2,
  "resource": { "url": "https://example.com/protected.html" },
  "accepted": {
    "scheme": "fluxacredit",
    "network": "fluxa:monetize",
    "amount": "25",
    "asset": "FLUXA_CREDIT",
    "payTo": "fluxa:facilitator:us-east-1",
    "maxTimeoutSeconds": 60,
    "extra": {
      "id": "1735689600-b4d2e1f0-7f2a-4e6c-9c1b-4b3a2c1d5e0f",
      "termsUrl": "https://example.com/terms"
    }
  },
  "payload": {
    "signature": "http-message-signatures",           
    "signature-fluxa-ai-agent-id": "<agent_or_thumbprint>",
    "challengeId": "1735689600-b4d2e1f0-7f2a-4e6c-9c1b-4b3a2c1d5e0f"
  }
}
```

Header requirements (Web Bot Auth)
- The HTTP `Signature-Input` for the bot MUST:
  - use `tag="web-bot-auth"`
  - include at least the components `@authority`, `"signature-agent"`, and `"payment-signature"` (the latter binds the payment JSON to the bot’s identity)
  - include short-lived `created`/`expires` and a `nonce` parameter
- The HTTP `Signature` MUST be a valid Ed25519 signature produced with the key published in `Signature-Agent`.
- The facilitator MUST retrieve the JWKS from the `Signature-Agent` URL (HTTPS) and verify `Signature-Input`/`Signature` per RFC 9421 and the Web Bot Auth drafts.

Notes
- `signature-fluxa-ai-agent-id` MUST either equal the JWK thumbprint in `Signature-Input`’s `keyid`, or be resolvable server-side to that thumbprint via a registry.
- `challengeId` MUST equal `accepted.extra.id` for idempotency and replay protection.
- Including `resource.url` in the PaymentPayload binds the JSON to the target path, and because `payment-signature` is covered, the binding inherits the bot’s signature.

---

## The Handshake Explained
This section shows the wire-level HTTP exchange, mirroring Cloudflare’s documentation style, adapted to `fluxacredit` with exact pricing.

1. The Server’s Offer (402)
  An unauthenticated crawler requests a resource. The server replies with `402 Payment Required` and an x402 `PaymentRequired` body quoting an exact credit amount.

  ```http
  HTTP/1.1 402 Payment Required
  Content-Type: application/json
  
  {
    "x402Version": 2,
    "resource": {
      "url": "https://example.com/protected.html",
      "description": "Paid crawl content",
      "mimeType": "text/html"
    },
    "accepts": [
      {
        "scheme": "fluxacredit",
        "network": "fluxa:monetize",
        "amount": "25",
        "asset": "FLUXA_CREDIT",
        "payTo": "fluxa:facilitator:us-east-1",
        "maxTimeoutSeconds": 60,
        "extra": {
          "id": "abc123",
          "termsUrl": "https://example.com/terms"
        }
      }
    ]
  }
  ```

2. The Client’s Signed Payment
  The crawler re-sends the request and includes a `PAYMENT-SIGNATURE` header with the x402 payload. Its HTTP Message Signature MUST cover the `payment-signature` field to bind identity to the payment JSON.

  ```http
  GET /protected.html HTTP/1.1
  Host: example.com
  User-Agent: MyBotCrawler/1.2 (+https://crawler.example)
  Signature-Agent: "https://crawler.example/.well-known/http-message-signatures-directory"
  Signature-Input: sig1=("payment-signature" "signature-agent" "@authority");created=1735689600;expires=1735693200;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";nonce="...";tag="web-bot-auth"
  Signature: sig1=:jdq0SqOwHdyHr9+r5jw3iYZH6aNGKijYp/EstF4RQTQdi5N5YYKrD+mCT1HA1nZDsi6nJKuHxUi/5Syp3rLWBA==:
  PAYMENT-SIGNATURE: eyJ4NDAyVmVyc2lvbiI6MiwiLi4uIn0=  ; base64url(JSON)
  ```

  Decoded PAYMENT-SIGNATURE JSON

  ```
  {
    "x402Version": 2,
    "resource": { "url": "https://example.com/protected.html" },
    "accepted": {
      "scheme": "fluxacredit",
      "network": "fluxa:monetize",
      "amount": "25",
      "asset": "FLUXA_CREDIT",
      "payTo": "fluxa:facilitator:us-east-1",
      "maxTimeoutSeconds": 60,
      "extra": { "id": "abc123" }
    },
    "payload": {
      "signature": "http-message-signatures",
      "signature-fluxa-ai-agent-id": "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U",
      "challengeId": "abc123"
    }
  }
  ```



3. Successful Response (200)
  The server verifies the signature and payment JSON, then serves the content and returns a confirmation header.

  ```
  HTTP/1.1 200 OK
  Content-Type: text/html; charset=utf-8
  PAYMENT-RESPONSE: eyJzY2hlbWUiOiJmbHV4YWNyZWRpdCIsIm5ldHdvcmsiOiJmbHV4YTptb25ldGl6ZSIsImlkIjoiYWJjMTIzIiwiY2hhcmdlZENyZWRpdHMiOiIyNSIsInRpbWVzdGFtcCI6MTczNTY5MzIwMH0=
  ```

  Decoded PAYMENT-RESPONSE JSON

  ```
  {
    "scheme": "fluxacredit",
    "network": "fluxa:monetize",
    "id": "abc123",
    "chargedCredits": "25",
    "timestamp": 1735693200
  }
  ```

  

4) Payment Settlement
  If verify and settle are separate, the CDN/origin calls the facilitator to debit the exact amount using the same challenge id for idempotency. When latency is critical, verify+settle MAY be performed atomically.

---
## Verification
Given `(PaymentPayload, PaymentRequirements)` in the retried request:
1. Requirements binding: ensure `accepted` matches the issued 402 entry (same `amount`, `asset`, `payTo`, and `extra.id`).
2. Identity: validate Web Bot Auth by verifying `Signature-Input`/`Signature` from the HTTP headers, using the JWKS discovered via `Signature-Agent`.
3. Coverage: enforce that `"payment-signature"` appears in the signed component list, so the PaymentPayload header is cryptographically bound to the bot identity.
4. Resource binding: ensure the verified `@authority` equals the authority of `resource.url`.
5. Replay protection: reject reused `extra.id` (idempotency key) and expired `Signature-Input` windows.

On success, the facilitator returns a `VerifyResponse` indicating the payment authorization is valid for the exact `amount`.

---

## Settlement
On successful content delivery, the server/CDN calls the facilitator `/settle` with the same `PaymentPayload` (or a reference) and `extra.id`. The facilitator debits exactly `accepted.amount` credits from the crawler’s FluxA account identified by the Web Bot Auth key, and returns a receipt:
- `success: true`, `creditsCharged = amount`, `balanceAfter`, `settlementId`.
- The operation MUST be idempotent on `extra.id`.

Note: If desired, verify and settle MAY be combined into a single atomic operation when latency is critical and idempotency is guaranteed.

---

## Errors
- `invalid_web_bot_auth`: key directory unknown, bad signature, expired window, or missing `"payment-signature"` in coverage.
- `insufficient_fluxa_credits`: account has insufficient credits for the exact amount.
- `stale_or_replayed_challenge`: `extra.id` reused or outside allowed window.
- `resource_authority_mismatch`: `@authority` does not match `resource.url` authority.

---

## Security considerations
- Require short windows: `expires - created ≤ 60s` for Web Bot Auth; `maxTimeoutSeconds ≤ 60s` for the 402.
- Bind the payment JSON: mandate coverage of the `payment-signature` header in `Signature-Input`.
- Idempotency: treat `extra.id` as an idempotency key; repeat settles with the same id MUST NOT double-charge.
- Directory signing: the JWKS directory SHOULD itself be HTTP‑signature‑signed per the directory draft to prevent mirrored impostors.
