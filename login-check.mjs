// CI-equivalent npm login check (no publish).
//
// Does exactly what the publish workflow's login phase does, from zero state:
//   - copies private.pem into a fresh temp dir (no signcount state, like a runner)
//   - launches a throwaway headless Chromium profile (signed out)
//   - runs `npm login --auth-type=web` against a temp userconfig (~/.npmrc untouched)
//   - Puppeteer types NPM_USERNAME / NPM_PASSWORD, clicks "Use security key",
//     and the WebAuthn shim signs the challenge with the PEM key
//   - checks `npm whoami`, then revokes the test token with `npm logout`
//
// Usage:  source ~/webauthn-keys/npm.env && node login-check.mjs [--headed]
// Screenshots/trace: ~/webauthn-keys/login-check-run/  (password field is masked)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { launchEphemeral } from './chromium.mjs';
import { installShim, loadSigner, shimInstalled } from './webauthn-shim.mjs';

const { NPM_USERNAME, NPM_PASSWORD, NPM_CREDENTIAL_ID, NPM_KEY_DIR } = process.env;
const missing = Object.entries({ NPM_USERNAME, NPM_PASSWORD, NPM_CREDENTIAL_ID, NPM_KEY_DIR }).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) { console.error(`missing env: ${missing.join(', ')}`); process.exit(2); }

const HEADED = process.argv.includes('--headed');
const ATTEMPTS = Math.max(1, Number(process.env.LOGIN_CHECK_ATTEMPTS) || 3);
const RUN_DIR = process.env.LOGIN_CHECK_RUN_DIR ?? path.join(os.homedir(), 'webauthn-keys', 'login-check-run');
fs.rmSync(RUN_DIR, { recursive: true, force: true });
fs.mkdirSync(RUN_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(3000 + Math.floor(Math.random() * 2000));
const redact = (s) => s.replaceAll(NPM_PASSWORD, '<password>').replace(/(cli(?:\/|%2F))[A-Za-z0-9-]{8,}/gi, '$1<session>');
const LOG_FILE = path.join(RUN_DIR, 'run.log');
const log = (step, msg) => { const line = `${new Date().toISOString()} [${step}] ${redact(String(msg))}`; console.log(line); fs.appendFileSync(LOG_FILE, line + '\n'); };
let lastState = '';
let shot = 0;
const capture = async (page, label) => { try { await page.screenshot({ path: path.join(RUN_DIR, `${String(++shot).padStart(2, '0')}-${label}.png`) }); } catch {} };

// Fresh key dir, as publish.yml does with mktemp -d.
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-key-'));
fs.chmodSync(keyDir, 0o700);
fs.copyFileSync(path.join(NPM_KEY_DIR, 'private.pem'), path.join(keyDir, 'private.pem'));
fs.chmodSync(path.join(keyDir, 'private.pem'), 0o600);
const userconfig = path.join(keyDir, 'npmrc');
fs.writeFileSync(userconfig, '', { mode: 0o600 });

const signer = await loadSigner({ keyDir, credentialId: NPM_CREDENTIAL_ID });
if (signer.keyType !== 'ec') throw new Error(`expected an EC key, got ${signer.keyType}`);
log('key', `P-256 credential ${signer.credentialIdText.slice(0, 12)}… (fresh key dir, no counter state)`);

const chrome = await launchEphemeral({ headless: !HEADED });
log('browser', `ephemeral Chromium ${HEADED ? 'headed' : 'headless'} on ${chrome.endpoint}`);

async function attempt(n) {
  const before = signer.signCounts.length;
  const child = spawn('npm', ['login', '--auth-type=web', '--browser=false', `--userconfig=${userconfig}`],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'true' } });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  let url;
  for (let i = 0; i < 100 && !url; i++) { await sleep(150); url = out.match(/https:\/\/www\.npmjs\.com\/(?:login\?next=\S+|login\/cli\/[A-Za-z0-9-]+)/)?.[0]; }
  if (!url) { child.kill(); return { ok: false, why: `npm login printed no URL: ${out.slice(-300)}` }; }
  log('npm', `login URL ${url}`);

  const browser = await puppeteer.connect({ browserURL: chrome.endpoint });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  let why = 'timed out';
  try {
    await page.goto('about:blank');
    if (!(await installShim(page, signer))) throw new Error('shim failed to install');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    if (!(await shimInstalled(page))) throw new Error('shim missing after navigation');
    await settle();
    await capture(page, `a${n}-loaded`);
    let submitted = false; let clicked = false;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const s = await page.evaluate(() => ({
        url: location.href,
        text: document.body.innerText.replace(/\s+/g, ' '),
        needsLogin: !!document.querySelector('input[name="username"], input[type="email"]') && !!document.querySelector('input[name="password"], input[type="password"]'),
        key: [...document.querySelectorAll('button, a')].some((c) => /use security key/i.test(c.textContent ?? '')),
      })).catch(() => null);
      if (!s) { await sleep(500); continue; }
      const st = `${s.url} | login=${s.needsLogin} key=${s.key} | ${s.text.replace(/^.*?Learn how to prepare \S+ \S+ /, '').slice(0, 200)}`;
      if (st !== lastState) { log('trace', st); lastState = st; }
      if (/Authentication Successful|You can close this tab|authorized/i.test(s.text)) { await capture(page, `a${n}-success`); why = null; break; }
      if (/Just a moment|Performing security verification|Verifying you are human/i.test(s.text)) { log('page', 'Cloudflare interstitial; waiting'); await capture(page, `a${n}-cloudflare`); await settle(); continue; }
      if (clicked && /Something went wrong/i.test(s.text)) { await capture(page, `a${n}-rejected`); why = 'npm rejected the assertion'; break; }
      if (s.needsLogin) {
        if (submitted) { await capture(page, `a${n}-reprompted`); why = 'npm re-prompted for credentials (wrong password or rate limited)'; break; }
        log('page', `typing username "${NPM_USERNAME}" and password`);
        await (await page.$('input[name="username"], input[type="email"]')).type(NPM_USERNAME, { delay: 40 });
        await settle();
        await (await page.$('input[name="password"], input[type="password"]')).type(NPM_PASSWORD, { delay: 40 });
        await settle();
        await page.click('button[type="submit"]');
        submitted = true;
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        await settle();
        await capture(page, `a${n}-after-login`);
        continue;
      }
      if (s.key && !clicked) {
        await settle();
        clicked = await page.evaluate(() => { const b = [...document.querySelectorAll('button, a')].find((c) => /use security key/i.test(c.textContent ?? '')); b?.click(); return !!b; });
        log('page', 'clicked "Use security key"');
        continue;
      }
      await sleep(500);
    }
    if (why) await capture(page, `a${n}-end`);
  } finally {
    // Let npm finish the CLI handshake from the success page before closing it.
    for (let i = 0; i < 60 && child.exitCode === null; i++) await sleep(500);
    await page.close().catch(() => {});
    await browser.disconnect();
    if (child.exitCode === null) child.kill();
  }
  const signed = signer.signCounts.length > before;
  const who = spawnSync('npm', ['whoami', `--userconfig=${userconfig}`], { encoding: 'utf8' });
  if (who.status === 0 && signed) return { ok: true, user: who.stdout.trim() };
  return { ok: false, why: why ?? (signed ? 'whoami failed after assertion' : 'no assertion signed') };
}

let result;
try {
  for (let n = 1; n <= ATTEMPTS; n++) {
    result = await attempt(n);
    if (result.ok) break;
    log('auth', `attempt ${n} failed: ${result.why}`);
    if (n < ATTEMPTS) { log('auth', `backing off ${15 * n}s`); await sleep(15000 * n); }
  }
} finally {
  await chrome.close();
  if (result?.ok) spawnSync('npm', ['logout', `--userconfig=${userconfig}`], { encoding: 'utf8' });
  fs.rmSync(keyDir, { recursive: true, force: true });
}
if (result?.ok) {
  log('done', `LOGIN OK as ${result.user} via username/password + PEM security key (signCounts ${signer.signCounts.join(', ')}); test token revoked`);
} else {
  log('done', `LOGIN FAILED: ${result?.why}. Screenshots in ${RUN_DIR}`);
  process.exitCode = 1;
}
console.log(`full log: ${LOG_FILE}`);
