/*
  Run all: JWKS directory (key agent), facilitator, resource server, and client.
  Prints Web Bot Auth verification details and demonstrates a full successful flow.
  Usage: node examples/fluxacredit/minimal/run-all.js
*/

const http = require('node:http');
const { URL } = require('node:url');
const crypto = require('node:crypto');

function b64url(input) { return Buffer.from(input).toString('base64url'); }
function fromB64url(input) { return Buffer.from(input, 'base64url'); }
function jsonB64url(obj) { return b64url(JSON.stringify(obj)); }

// 1) Generate Ed25519 keypair and publish JWKS via local directory
function genKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }); // {kty:'OKP', crv:'Ed25519', x:'base64url'}
  // RFC 7638 thumbprint over sorted members
  const thumbSrc = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  const thumb = crypto.createHash('sha256').update(thumbSrc).digest('base64url');
  return { publicKey, privateKey, jwk, thumb };
}

function startJwksServer({ port, jwk }) {
  const path = '/.well-known/http-message-signatures-directory';
  const server = http.createServer((req, res) => {
    if (req.url === path) {
      const body = JSON.stringify({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: jwk.x }] });
      res.writeHead(200, {
        'Content-Type': 'application/http-message-signatures-directory+json',
        'Cache-Control': 'no-cache'
      });
      res.end(body);
    } else {
      res.writeHead(404).end();
    }
  });
  return new Promise(resolve => server.listen(port, () => {
    console.log(`[JWKS] listening http://localhost:${port}${path}`);
    resolve({ server, url: `"http://localhost:${port}${path}"` });
  }));
}

// 2) Facilitator with real Ed25519 verify over the minimal signature base used by this demo
function parseSigInput(input) {
  const idx = input.indexOf('=');
  const label = input.slice(0, idx).trim();
  const rest = input.slice(idx + 1).trim();
  const open = rest.indexOf('('), close = rest.indexOf(')');
  const compStr = rest.slice(open + 1, close).trim();
  const rawParamsSection = rest.slice(open, rest.length).trim();
  const comps = [];
  let i = 0;
  while (i < compStr.length) {
    while (i < compStr.length && compStr[i] === ' ') i++;
    if (i >= compStr.length) break;
    if (compStr[i] === '"') {
      const j = compStr.indexOf('"', i + 1);
      comps.push(compStr.slice(i + 1, j));
      i = j + 1;
    } else if (compStr[i] === '@') {
      const j = compStr.indexOf(' ', i);
      const end = j === -1 ? compStr.length : j;
      comps.push(compStr.slice(i, end));
      i = end;
    } else {
      const j = compStr.indexOf(' ', i);
      const end = j === -1 ? compStr.length : j;
      comps.push(compStr.slice(i, end));
      i = end;
    }
  }
  const params = {};
  const paramStr = rest.slice(close + 1).trim();
  for (const part of paramStr.split(';').map(s => s.trim()).filter(Boolean)) {
    const ei = part.indexOf('=');
    const k = part.slice(0, ei).trim();
    let v = part.slice(ei + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }
  return { label, components: comps, params, rawParamsSection };
}

function parseSignatureHeader(signature) {
  const idx = signature.indexOf('=');
  const label = signature.slice(0, idx).trim();
  const rest = signature.slice(idx + 1).trim();
  const m = rest.match(/^:([A-Za-z0-9+/=]+):$/);
  return { label, sig: Buffer.from(m[1], 'base64') };
}

function buildSignatureBase(parsed, headers, authority) {
  const lines = [];
  for (const c of parsed.components) {
    if (c === '@authority') {
      lines.push('"@authority": ' + authority);
    } else {
      const name = c.toLowerCase();
      const val = headers[name];
      if (val === undefined) throw new Error('missing_header:' + name);
      lines.push('"' + name + '": ' + val);
    }
  }
  lines.push('"@signature-params": ' + parsed.rawParamsSection);
  return Buffer.from(lines.join('\n'), 'utf8');
}

function startFacilitator({ port }) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};

    if (req.method === 'POST' && req.url === '/verify') {
      const { paymentPayload, paymentRequirements } = body;
      const ext = (paymentPayload.extensions && paymentPayload.extensions['web-bot-auth']) || {};
      const okReq = JSON.stringify(paymentPayload.accepted) === JSON.stringify(paymentRequirements);
      try {
        const parsed = parseSigInput(String(ext.signatureInput || ''));
        const { label, sig } = parseSignatureHeader(String(ext.signature || ''));
        const keyid = parsed.params['keyid'];

        // Construct base
        const auth = new URL(paymentPayload.resource.url).host;
        const signedHeaders = {
          'payment-signature': String(ext.paymentSignatureHeader || ''),
          'signature-agent': String(ext.signatureAgent || ''),
        };
        const base = buildSignatureBase(parsed, signedHeaders, auth);

        // Fetch JWKS and find matching thumbprint
        const jwksUrl = String(ext.signatureAgent).slice(1, -1);
        const jwks = await fetch(jwksUrl).then(r => r.json());
        let pub = null; let matchedThumb = null;
        for (const k of jwks.keys || []) {
          if (k.kty !== 'OKP' || k.crv !== 'Ed25519') continue;
          const thumbSrc = JSON.stringify({ crv: k.crv, kty: k.kty, x: k.x });
          const thumb = crypto.createHash('sha256').update(thumbSrc).digest('base64url');
          if (thumb === keyid) { pub = fromB64url(k.x); matchedThumb = thumb; break; }
        }

        const verifyOk = pub ? crypto.verify(null, base, crypto.createPublicKey({ key: { kty:'OKP', crv:'Ed25519', x: Buffer.from(pub).toString('base64url') }, format:'jwk' }), sig) : false;

        console.log('\n[VERIFY DETAIL]');
        console.log(' components =', parsed.components);
        console.log(' keyid =', keyid, ' matchedThumb =', matchedThumb);
        console.log(' base =\n' + base.toString('utf8'));
        console.log(' verifyOk =', verifyOk);

        const isValid = okReq && verifyOk;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ isValid, invalidReason: isValid ? undefined : 'invalid_web_bot_auth' }));
      } catch (e) {
        console.error('[verify error]', e);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ isValid: false, invalidReason: 'invalid_web_bot_auth' }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/settle') {
      const { paymentRequirements } = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, transaction: `credit-ledger:${paymentRequirements.extra.id}`, network: paymentRequirements.network }));
      return;
    }

    res.writeHead(404).end();
  });
  return new Promise(resolve => server.listen(port, () => {
    console.log(`[FACILITATOR] http://localhost:${port}`);
    resolve(server);
  }));
}

// 3) Resource server (402 → retry)
function startResourceServer({ port }) {
  const server = http.createServer(async (req, res) => {
    const url = `http://localhost:${port}${req.url}`.replace(/\/$/, '');
    const ps = req.headers['payment-signature'];
    if (!ps) {
      const paymentRequired = {
        x402Version: 2,
        resource: { url, description: 'Paid crawl content', mimeType: 'text/html' },
        accepts: [{
          scheme: 'fluxacredit', network: 'fluxa:monetize', amount: '25', asset: 'FLUXA_CREDIT',
          payTo: 'fluxa:facilitator:us-east-1', maxTimeoutSeconds: 60, extra: { id: 'abc123', termsUrl: 'https://example.com/terms' }
        }]
      };
      res.writeHead(402, { 'Content-Type': 'application/json', 'PAYMENT-REQUIRED': jsonB64url(paymentRequired) });
      res.end(JSON.stringify({ error: 'Payment required' }));
      return;
    }

    const paymentPayload = JSON.parse(Buffer.from(ps, 'base64url').toString('utf8'));
    paymentPayload.extensions = {
      ...(paymentPayload.extensions || {}),
      'web-bot-auth': {
        signatureAgent: req.headers['signature-agent'],
        signatureInput: req.headers['signature-input'],
        signature: req.headers['signature'],
        paymentSignatureHeader: ps,
      }
    };

    const verify = await fetch('http://localhost:4023/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paymentPayload, paymentRequirements: paymentPayload.accepted })
    }).then(r => r.json());
    if (!verify.isValid) {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: verify.invalidReason }));
      return;
    }

    const settle = await fetch('http://localhost:4023/settle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paymentPayload, paymentRequirements: paymentPayload.accepted })
    }).then(r => r.json());

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'PAYMENT-RESPONSE': jsonB64url({
      scheme: 'fluxacredit', network: 'fluxa:monetize', id: paymentPayload.accepted.extra.id, chargedCredits: paymentPayload.accepted.amount, timestamp: Math.floor(Date.now()/1000)
    }) });
    res.end('<h1>hello paid content</h1>\n<pre>' + JSON.stringify(settle) + '</pre>');
  });
  return new Promise(resolve => server.listen(port, () => {
    console.log(`[SERVER] http://localhost:${port}`);
    resolve(server);
  }));
}

// 4) Client: discovery 402 → retry with signed headers (Signature-Input covers payment-signature)
async function runClient({ serverPort, signatureAgentUrl, privateKey, thumb }) {
  const path = '/protected.html';
  function req(opts, body) {
    return new Promise(resolve => {
      const r = http.request(opts, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      });
      if (body) r.write(body);
      r.end();
    });
  }

  const r1 = await req({ host: 'localhost', port: serverPort, path, method: 'GET' });
  console.log('[CLIENT] step1 status=', r1.status);
  const required = JSON.parse(Buffer.from(String(r1.headers['payment-required']), 'base64url').toString('utf8'));
  const accepted = required.accepts[0];

  const paymentPayload = {
    x402Version: 2,
    resource: { url: `http://localhost:${serverPort}${path}` },
    accepted,
    payload: { signature: 'http-message-signatures', 'signature-fluxa-ai-agent-id': thumb, challengeId: accepted.extra.id },
  };
  const paymentSignature = jsonB64url(paymentPayload);

  const created = Math.floor(Date.now()/1000);
  const expires = created + 60;
  const label = 'sig1';
  const signatureAgent = signatureAgentUrl; // already quoted
  const signatureInput = `${label}=("payment-signature" "signature-agent" "@authority");created=${created};expires=${expires};keyid="${thumb}";alg="ed25519";nonce="demo-nonce";tag="web-bot-auth"`;

  // Build base exactly as facilitator does
  const parsed = parseSigInput(signatureInput);
  const authority = `localhost:${serverPort}`;
  const base = buildSignatureBase(parsed, { 'payment-signature': paymentSignature, 'signature-agent': signatureAgent }, authority);
  const sigBuf = crypto.sign(null, base, privateKey);
  const signature = `${label}=:${sigBuf.toString('base64')}:`;

  const r2 = await req({ host: 'localhost', port: serverPort, path, method: 'GET', headers: {
    'PAYMENT-SIGNATURE': paymentSignature,
    'Signature-Agent': signatureAgent,
    'Signature-Input': signatureInput,
    'Signature': signature,
  }});
  console.log('[CLIENT] step2 status=', r2.status);
  console.log('[CLIENT] payment-response=', r2.headers['payment-response']);
}

(async () => {
  const key = genKeypair();
  const jwks = await startJwksServer({ port: 5051, jwk: key.jwk });
  const facilitator = await startFacilitator({ port: 4023 });
  const server = await startResourceServer({ port: 4022 });
  try {
    await runClient({ serverPort: 4022, signatureAgentUrl: jwks.url, privateKey: key.privateKey, thumb: key.thumb });
  } catch (e) {
    console.error('[RUN ERROR]', e);
  } finally {
    setTimeout(() => { server.close(); facilitator.close(); jwks.server.close(); }, 500);
  }
})();
