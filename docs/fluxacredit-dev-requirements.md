# fluxacredit 开发需求（方案 B｜不改 Core Types）

目标：在不修改 x402 v2 核心类型与接口的前提下，实现 `fluxacredit` 精确定价（exact price）方案，复用 Web Bot Auth 身份认证，并以最小侵入的方式落地到本仓库（TypeScript 优先）。

—— 精确定价：服务端在 402 中返回“确切 credits 金额”，客户端重试并支付，facilitator 精确扣费。
—— 身份绑定：HTTP Message Signatures 必须覆盖 `payment-signature` 头（绑定身份与付款 JSON）。
—— 方案 B 约束：不改 Core Types；由“资源服务器”在调用 facilitator 前，把 Web Bot Auth 三个 HTTP 头原文注入 `PaymentPayload.extensions["web-bot-auth"]`。


## 一、范围与非目标
- 范围（Do）
  - 新增 TS 机制包（client/server/facilitator）以支持 `fluxacredit`（network 固定 `fluxa:monetize`）。
  - 示例最小实现（独立 http 服务，不依赖 Next.js 等框架）。
  - E2E 场景：按 “The Handshake Explained” 走通 402 → 重试 → 200 → 结算。
  - 文档：面向开发者的“原子化”集成说明（client/server/facilitator）。
- 非目标（Don’t）
  - 不修改 core 类型或接口签名（types/interfaces）。
  - 不改造现有 HTTP 客户端/服务端核心流程，只在示例中做 extensions 注入。


## 二、交付物清单与文件结构
- 规范与指南（已存在/需补充）
  - specs/schemes/fluxacredit/scheme_fluxacredit.md（已存在，精确定价+签名覆盖）
  - docs/fluxacredit-minimal.md（已存在，原子化最小示例指南）
- 新增机制包（TS）
  - typescript/packages/mechanisms/fluxa/credit/
    - src/client/scheme.ts（SchemeNetworkClient）
    - src/server/scheme.ts（SchemeNetworkServer）
    - src/facilitator/scheme.ts（SchemeNetworkFacilitator）
    - src/utils/webBotAuthVerifier.ts（接口 + mock 实现）
    - src/utils/ledger.ts（Monetize 记账接口 + 内存实现）
    - index.ts（统一导出）
- 示例（最小可跑，不依赖框架）
  - examples/fluxacredit/minimal/
    - client.ts（发起 402 → 重试，含三签名头覆盖 "payment-signature"）
    - server.ts（返回 402；重试时将三签名头注入 `extensions['web-bot-auth']`；/verify→/settle→200）
    - facilitator.ts（/verify & /settle；mock 验签与记账）
    - jwks-directory/（静态签名目录，测试用）
    - package.json 脚本（tsx 运行）
- E2E（新增用例）
  - e2e/src/fluxacredit.e2e.ts（按握手示例跑通，断言 200、支付回执、记账发生）


## 三、实现细节（要求与验收标准）
### 1) Scheme：Client（SchemeNetworkClient）
- 文件：typescript/packages/mechanisms/fluxa/credit/src/client/scheme.ts
- 行为：
  - `scheme = "fluxacredit"`。
  - `createPaymentPayload(x402Version, requirements)` 返回：
    - `x402Version: 2`
    - `payload` 仅包含最小字段：
      - `signature: "http-message-signatures"`
      - `signature-fluxa-ai-agent-id: string`（agent id 或 JWK thumbprint）
      - `challengeId: requirements.extra.id`
    - 不在此层生成/注入 Web Bot Auth 三个头；由调用方或“服务端桥接”完成。
- 验收：
  - 单测覆盖：返回结构与要求一致；不包含多余字段；`challengeId` 与 `extra.id` 一致。

### 2) Scheme：Server（SchemeNetworkServer）
- 文件：typescript/packages/mechanisms/fluxa/credit/src/server/scheme.ts
- 行为：
  - `parsePrice(price, network)`：
    - 支持数字/字符串 → `{ amount: string, asset: "FLUXA_CREDIT" }`。
    - 支持 `{ amount, asset }` 直接透传；asset 必须为 `FLUXA_CREDIT`。
  - `enhancePaymentRequirements(base, supportedKind, extensions)`：
    - 保持 `amount` 为“精确扣费”的字符串；
    - 若无 `extra.id`，生成 `time-based nonce`（如 `unix-ns + uuid`）。
    - 允许透传 `termsUrl` 等字段。
- 验收：
  - 单测覆盖：价格解析与错误分支（asset 错误、负数等）；`extra.id` 自动生成。

### 3) Scheme：Facilitator（SchemeNetworkFacilitator）
- 文件：typescript/packages/mechanisms/fluxa/credit/src/facilitator/scheme.ts
- 行为：
  - `scheme = "fluxacredit"`；`caipFamily = "fluxa:*"`；`getExtra()` 返回 undefined；`getSigners()` 返回空数组即可（credits 账本非链）。
  - `verify(paymentPayload, requirements)`：
    - 从 `paymentPayload.extensions['web-bot-auth']` 读取：`signatureAgent`、`signatureInput`、`signature`、`paymentSignatureHeader`（建议服务器原样注入该头的原始值，用于签名覆盖验证）。
    - 验证：
      - `accepted` 与 `requirements` 全等（amount/asset/payTo/extra.id）。
      - Web Bot Auth 验签：
        - `signature-agent` 为 HTTPS；
        - `signature-input` `tag=web-bot-auth`，覆盖 `"payment-signature"`；
        - `expires - created ≤ 60s`；
        - 可调用 `webBotAuthVerifier.verify(headers)`（mock 先校验形态 & 覆盖项，生产可替换为 Cloudflare 库）。
      - `resource.url` 的 authority 等于已验证 `@authority`。
    - 返回：`{ isValid:true, payer:<thumbprint_or_agent> }` 或 `{ isValid:false, invalidReason }`。
  - `settle(paymentPayload, requirements)`：
    - 通过 `ledger.debitExact({ id: requirements.extra.id, agent: <thumbprint_or_agent>, amount: requirements.amount })` 记账；
    - 返回 `{ success:true, transaction:"credit-ledger:<id>", network:"fluxa:monetize" }`。
- 依赖抽象：
  - `webBotAuthVerifier.ts`：
    - 接口：`verify({ signatureAgent, signatureInput, signature, paymentSignatureHeader, method, url }) : { ok:boolean, thumbprint?:string, error?:string }`
    - 默认实现：只校验形态、HTTPS、Signature-Input 覆盖 `"payment-signature"`；返回 `ok:true` 与 `thumbprint=keyid`。
  - `ledger.ts`：
    - 接口：`debitExact({ id, agent, amount }): { ok:boolean, balanceAfter?:string, txId:string }`（需幂等）
    - 默认实现：内存 Map；同一 id 重复调用返回相同 txId。
- 验收：
  - 单测：缺失任一 Web Bot Auth 字段/覆盖项 → `isValid:false`；authority 不匹配 → `isValid:false`；正常路径 → `isValid:true`。
  - 结算：重复 `id` 不二次扣账，返回同一 `txId`。

### 4) 示例（不依赖框架）
- 目录：examples/fluxacredit/minimal/
- 内容：
  - client.ts：
    - 首次请求 → 解析 402（从 `PAYMENT-REQUIRED` 头）
    - 构建 PaymentPayload，生成 `PAYMENT-SIGNATURE`，生成三签名头（签名覆盖 `"payment-signature"`），重试
  - server.ts：
    - 无支付 → 402 + `PAYMENT-REQUIRED`（amount=精确 credits，extra.id=挑战）
    - 有支付 → decode PaymentPayload → 注入三签名头到 `extensions['web-bot-auth']` → `/verify` → `/settle` → 200 + `PAYMENT-RESPONSE`
  - facilitator.ts：
    - `/verify` 按上述规则校验；`/settle` 精确扣费；返回收据
  - jwks-directory/：静态目录响应（测试用公钥）
  - 脚本：`pnpm run start:server|start:facilitator|start:client`
- 验收：
  - 本地启动三进程后，client 输出 200 且含 `PAYMENT-RESPONSE`，facilitator 输出记账结果。

### 5) E2E
- 文件：e2e/src/fluxacredit.e2e.ts
- 步骤：
  1. 起 server、facilitator、jwks 目录
  2. GET → 402；解析 `PAYMENT-REQUIRED`
  3. 构造 `PAYMENT-SIGNATURE` 与三签名头（覆盖 `"payment-signature"`）并重试
  4. 断言 200、存在 `PAYMENT-RESPONSE`、facilitator 记录了扣账
- 验收：
  - CI 可运行；失败信息可定位（缺头、过期、覆盖缺失等）


## 四、代码集成与脚手架
- Monorepo 注册
  - 在 `typescript/pnpm-workspace.yaml` 中增加 `packages/mechanisms/fluxa/*` 路径。
  - 在 `typescript/packages/mechanisms/fluxa/credit/package.json` 配置 `name`, `main`, `types`, `build` 脚本（tsup/tsc）。
- 导出点
  - 在 `typescript/packages/mechanisms/fluxa/credit/index.ts` 导出 client/server/facilitator。
- 支持查询（示例 facilitator）
  - `/supported` 返回：`{ kinds:[{ x402Version:2, scheme:"fluxacredit", network:"fluxa:monetize" }], extensions:[], signers:{} }`


## 五、测试与质量
- 单元测试
  - client：payload 字段正确；challengeId 一致
  - server：parsePrice & enhancePaymentRequirements；id 生成
  - facilitator：
    - 缺少 `signature-input/signature/signature-agent` → invalid
    - 未覆盖 `"payment-signature"` → invalid
    - `@authority` 与 `resource.url` 不一致 → invalid
    - 正常 → valid；settle 幂等
- 集成/E2E
  - 跑通握手示例
- 质量门槛
  - 通过 `pnpm -C typescript build test`
  - ESLint/Prettier 通过；Vitest 覆盖新增代码的关键路径


## 六、风险与规避
- Header 体积：`PAYMENT-SIGNATURE` + 三签名头可能较大，需注意代理/网关头大小限制（示例控制 JSON 最小字段）。
- 目录可用性：JWKS 拉取失败应有重试与短负缓存（示例可简化）。
- 时间窗口：签名 `expires-created ≤ 60s`，服务端时间漂移需留余量。


## 七、里程碑与分工
- M1（机制包雏形，2 天）
  - 完成 client/server/facilitator 代码骨架、mock verifier 与 ledger、单测
- M2（最小示例 & 文档，2 天）
  - minimal client/server/facilitator 可跑通；完善 docs/fluxacredit-minimal.md
- M3（E2E 与打磨，2–3 天）
  - e2e 场景、错误用例、完善日志与错误码


## 八、验收标准（Definition of Done）
- `examples/fluxacredit/minimal` 本地三进程可跑通，打印 200 与 PAYMENT-RESPONSE。
- E2E 用例通过；单测覆盖关键分支。
- 规范与指南与实现一致：
  - 签名覆盖 `"payment-signature"`
  - 精确定价，无预授权流程
  - extensions['web-bot-auth'] 注入路径清晰（方案 B）
