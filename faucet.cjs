#!/usr/bin/env node
/**
 * BSV Faucet — Public faucet to fund OpenClaw agent wallets
 * Drips 10,000 satoshis per claim, one claim per address.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// Config
const PORT = process.env.FAUCET_PORT || 3000;
const DRIP_SATS = 10000; // 0.0001 BSV
const WALLET_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.openclaw', 'bsv-faucet.json');
const LEDGER_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.openclaw', 'bsv-faucet-ledger.json');
const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main';
const SAT_PER_BSV = 1e8;
const FEE_RATE = 1; // sat/byte

// --- HTTP helpers ---

function httpGet(urlStr) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, { headers: { 'User-Agent': 'bsv-faucet/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

function httpPost(urlStr, body) {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: url.hostname, path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// --- Wallet ---

function ensureBsv() {
  try {
    return require('bsv');
  } catch {
    const { execSync } = require('child_process');
    const dir = __dirname;
    if (!fs.existsSync(path.join(dir, 'node_modules', 'bsv'))) {
      console.log('Installing bsv package...');
      execSync('npm install bsv@2 --save --no-fund --no-audit', { cwd: dir, stdio: 'inherit' });
    }
    return require(path.join(dir, 'node_modules', 'bsv'));
  }
}

function loadWallet() {
  if (!fs.existsSync(WALLET_PATH)) return null;
  return JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
}

function saveWallet(data) {
  fs.mkdirSync(path.dirname(WALLET_PATH), { recursive: true });
  fs.writeFileSync(WALLET_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function initWallet() {
  const existing = loadWallet();
  if (existing) return existing;
  const bsv = ensureBsv();
  const privKey = bsv.PrivKey.fromRandom();
  const keyPair = bsv.KeyPair.fromPrivKey(privKey);
  const address = bsv.Address.fromPubKey(keyPair.pubKey).toString();
  const wif = privKey.toWif();
  const wallet = { wif, address, created: new Date().toISOString() };
  saveWallet(wallet);
  return wallet;
}

// --- Ledger ---

function loadLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return {};
  return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
}

function saveLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

function checkCooldown(address) {
  const ledger = loadLedger();
  const entry = ledger[address];
  if (!entry) return { canClaim: true };
  const elapsed = Date.now() - new Date(entry.timestamp).getTime();
  if (elapsed >= COOLDOWN_MS) return { canClaim: true };
  const remainingMin = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
  return { canClaim: false, remainingMin };
}

function recordClaim(address, txid) {
  const ledger = loadLedger();
  ledger[address] = { txid, timestamp: new Date().toISOString() };
  saveLedger(ledger);
}

// --- Send BSV ---

async function sendDrip(toAddress) {
  const bsv = ensureBsv();
  const w = loadWallet();
  if (!w) throw new Error('Faucet wallet not initialized');

  // Validate address
  try { bsv.Address.fromString(toAddress); } catch { throw new Error('Invalid BSV address'); }

  // Don't send to self
  if (toAddress === w.address) throw new Error('Cannot claim to faucet address');

  // Fetch UTXOs
  const utxos = await httpGet(`${WOC_BASE}/address/${w.address}/unspent`);
  if (!utxos.length) throw new Error('Faucet has no UTXOs (empty)');

  utxos.sort((a, b) => b.value - a.value);

  let selected = [];
  let totalIn = 0;
  for (const u of utxos) {
    selected.push(u);
    totalIn += u.value;
    const estFee = (148 * selected.length + 34 * 2 + 10) * FEE_RATE;
    if (totalIn >= DRIP_SATS + estFee) break;
  }

  const fee = (148 * selected.length + 34 * 2 + 10) * FEE_RATE;
  const change = totalIn - DRIP_SATS - fee;
  if (change < 0) throw new Error('Faucet has insufficient funds');

  const privKey = bsv.PrivKey.fromWif(w.wif);
  const keyPair = bsv.KeyPair.fromPrivKey(privKey);
  const pubKey = keyPair.pubKey;

  const txb = new bsv.TxBuilder();
  txb.outputToAddress(new bsv.Bn(DRIP_SATS), bsv.Address.fromString(toAddress));
  if (change > 546) {
    txb.setChangeAddress(bsv.Address.fromString(w.address));
  }

  for (const u of selected) {
    const rawTx = await httpGet(`${WOC_BASE}/tx/${u.tx_hash}/hex`);
    const tx = bsv.Tx.fromHex(typeof rawTx === 'string' ? rawTx : rawTx.hex || rawTx);
    const txOut = tx.txOuts[u.tx_pos];
    const txHashBuf = Buffer.from(u.tx_hash, 'hex').reverse();
    txb.inputFromPubKeyHash(txHashBuf, u.tx_pos, txOut, pubKey);
  }

  txb.setFeePerKbNum(FEE_RATE * 1000);
  txb.build({ useAllInputs: true });
  for (let i = 0; i < selected.length; i++) {
    txb.signWithKeyPairs([keyPair]);
  }

  const txHex = txb.tx.toHex();
  const result = await httpPost(`${WOC_BASE}/tx/raw`, { txhex: txHex });
  const txid = typeof result === 'string' ? result.replace(/"/g, '') : result.txid || result;
  return txid;
}

// --- HTTP Server ---

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
    });
  });
}

function respond(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET / — status
  if (req.method === 'GET' && req.url === '/') {
    const w = loadWallet();
    try {
      const bal = await httpGet(`${WOC_BASE}/address/${w.address}/balance`);
      const ledger = loadLedger();
      return respond(res, 200, {
        status: 'running',
        address: w.address,
        balance: bal.confirmed / SAT_PER_BSV,
        balanceSats: bal.confirmed,
        dripSats: DRIP_SATS,
        totalClaims: Object.keys(ledger).length
      });
    } catch (e) {
      return respond(res, 200, { status: 'running', address: w.address, error: e.message });
    }
  }

  // POST /claim — claim drip
  if (req.method === 'POST' && req.url === '/claim') {
    try {
      const body = await parseBody(req);
      const address = body && body.address;
      if (!address) return respond(res, 400, { error: 'Missing address' });

      const cooldown = checkCooldown(address);
      if (!cooldown.canClaim) {
        return respond(res, 429, { error: `Try again in ${cooldown.remainingMin} minute(s)` });
      }

      const txid = await sendDrip(address);
      recordClaim(address, txid);

      return respond(res, 200, {
        success: true,
        address,
        amount: DRIP_SATS,
        amountBsv: DRIP_SATS / SAT_PER_BSV,
        txid
      });
    } catch (e) {
      return respond(res, 500, { error: e.message });
    }
  }

  respond(res, 404, { error: 'Not found' });
});

// --- CLI commands ---
const [,, cmd] = process.argv;

if (cmd === 'init') {
  const w = initWallet();
  console.log(`Faucet wallet: ${w.address}`);
  console.log(`Saved to: ${WALLET_PATH}`);
  console.log('Fund this address with BSV, then run: node faucet.cjs start');
  process.exit(0);
}

if (cmd === 'address') {
  const w = loadWallet();
  if (!w) { console.error('No wallet. Run: node faucet.cjs init'); process.exit(1); }
  console.log(w.address);
  process.exit(0);
}

if (cmd === 'balance') {
  const w = loadWallet();
  if (!w) { console.error('No wallet. Run: node faucet.cjs init'); process.exit(1); }
  httpGet(`${WOC_BASE}/address/${w.address}/balance`).then(bal => {
    console.log(`Address: ${w.address}`);
    console.log(`Balance: ${(bal.confirmed / SAT_PER_BSV).toFixed(8)} BSV (${bal.confirmed} sats)`);
  }).catch(e => { console.error(e.message); process.exit(1); });
  return;
}

if (cmd === 'start' || !cmd) {
  const w = loadWallet();
  if (!w) { console.error('No wallet. Run: node faucet.cjs init'); process.exit(1); }
  ensureBsv(); // install bsv package if needed
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`BSV Faucet running on http://0.0.0.0:${PORT}`);
    console.log(`Wallet: ${w.address}`);
    console.log(`Drip: ${DRIP_SATS} sats (${DRIP_SATS / SAT_PER_BSV} BSV) per claim`);
    console.log(`Endpoints:`);
    console.log(`  GET  /      — Faucet status`);
    console.log(`  POST /claim — { "address": "1xxx..." }`);
  });
  return;
}

console.log('BSV Faucet — Commands:');
console.log('  init      Create faucet wallet');
console.log('  address   Show faucet address');
console.log('  balance   Check faucet balance');
console.log('  start     Start the faucet server (default)');
