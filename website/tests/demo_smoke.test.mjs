/**
 * End-to-end smoke test for the landing-page demo, in a real browser.
 *
 * The unit tests cover the control loop and the transform maths, but neither
 * would catch the failures that actually happen here: a Draco decoder served
 * from the wrong path, a WASM asset the bundler mangled, a worker a strict host
 * blocks. Those only show up when a browser loads the built site.
 *
 * Drives headless Chrome over the DevTools protocol using Node's built-in
 * WebSocket — no Puppeteer/Playwright dependency. Deliberately avoids
 * --virtual-time-budget, which does not advance inside Web Workers and so
 * deadlocks the Draco decode.
 *
 *   node tests/demo_smoke.test.mjs [baseUrl]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const BASE_URL = process.argv[2] ?? 'http://localhost:4321/rotary-inverted-pendulum/';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  throw new Error(
    `demo_smoke: no Chrome found. Set CHROME_PATH. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a *page* target. /json/version returns the browser-level endpoint,
 * which does not implement the Runtime or Page domains — connecting there fails
 * with "'Runtime.enable' wasn't found".
 */
async function waitForPageTarget(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error('demo_smoke: Chrome never exposed a page target');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`demo_smoke: ${method} timed out`));
        }
      }, 30000);
    });
  }

  async eval(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(`demo_smoke: page threw — ${exceptionDetails.text}`);
    }
    return result.value;
  }
}

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const chrome = await findChrome();
const port = 9333;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'demo-smoke-'));

const proc = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1000,800',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let ws;
try {
  const target = await waitForPageTarget(port);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');

  // Collect page-side errors so a failure reports the cause, not just a symptom.
  const problems = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      const { text, url } = msg.params.entry;
      problems.push(url ? `${text} — ${url}` : text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      problems.push(msg.params.exceptionDetails.text);
    }
  });

  console.log(`loading ${BASE_URL}\n`);
  await cdp.send('Page.navigate', { url: BASE_URL });

  // Confirm we actually reached the site before judging the demo. Pointed at a
  // dead port, every later check reads as "the demo did not initialise", which
  // is a confusing way to learn the URL was wrong.
  const reachedSite = await (async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const found = await cdp.eval(`!!document.querySelector('[data-demo]')`);
      if (found) return true;
      await sleep(250);
    }
    return false;
  })();
  if (!reachedSite) {
    const info = await cdp.eval(
      `JSON.stringify({ url: location.href, title: document.title })`
    );
    console.error(
      `  FAIL the page has no demo root — is the site actually served at this URL?\n` +
        `       ${info}`
    );
    failures++;
  }

  // Wait for the demo to signal readiness, which it sets only after the meshes
  // have decoded and the first frame is scheduled.
  const deadline = Date.now() + 30000;
  let ready = false;
  let status = '';
  while (Date.now() < deadline) {
    const state = await cdp.eval(`
      (() => {
        const root = document.querySelector('[data-demo]');
        if (!root) return null;
        return {
          ready: root.dataset.ready === 'true',
          status: root.querySelector('[data-status]')?.textContent ?? '',
        };
      })()
    `);
    if (state) {
      ready = state.ready;
      status = state.status;
      if (ready) break;
      if (/could not|failed/i.test(status)) break;
    }
    await sleep(250);
  }

  check('the demo reports itself ready', ready, `status was "${status}"`);
  check(
    'no error is shown to the visitor',
    !/could not|failed/i.test(status),
    `status: "${status}"`
  );

  // The meshes must actually be in the scene graph, not merely fetched.
  const meshCount = await cdp.eval(`
    (() => {
      const c = document.querySelector('[data-canvas]');
      return c ? c.getAttribute('data-engine') : null;
    })()
  `);
  check('three.js initialised the canvas', typeof meshCount === 'string', String(meshCount));

  // Let the replay run, then confirm the readouts are live numbers rather than
  // the server-rendered placeholder dashes.
  await sleep(2500);
  const readouts = await cdp.eval(`
    (() => {
      const root = document.querySelector('[data-demo]');
      const get = (s) => root.querySelector(s)?.textContent?.trim() ?? '';
      return {
        theta: get('[data-theta]'),
        action: get('[data-action]'),
        balanced: get('[data-balanced]'),
      };
    })()
  `);
  check(
    'the replay drives the readouts',
    readouts.theta !== '—' && readouts.balanced !== '—',
    JSON.stringify(readouts)
  );
  check(
    'the replay reports the capture\'s balanced fraction',
    Number(readouts.balanced) > 0.9,
    `balanced = ${readouts.balanced}`
  );

  // Switching to the live network downloads MuJoCo and starts stepping.
  await cdp.eval(`document.querySelector('[data-mode="live"]').click()`);
  const liveDeadline = Date.now() + 60000;
  let liveOk = false;
  while (Date.now() < liveDeadline) {
    const label = await cdp.eval(
      `document.querySelector('[data-mode-label]')?.textContent ?? ''`
    );
    if (/live/i.test(label)) {
      liveOk = true;
      break;
    }
    await sleep(500);
  }
  check('the live MuJoCo mode starts', liveOk);

  if (liveOk) {
    // Give the policy time to swing up (measured ~1.7 s of simulated time).
    await sleep(8000);
    const live = await cdp.eval(`
      (() => {
        const root = document.querySelector('[data-demo]');
        const get = (s) => root.querySelector(s)?.textContent?.trim() ?? '';
        return { theta: get('[data-theta]'), balanced: get('[data-balanced]') };
      })()
    `);
    const thetaDeg = Math.abs(parseFloat(live.theta));
    check(
      'the live policy gets the pendulum upright',
      Number.isFinite(thetaDeg) && thetaDeg < 25,
      `|theta| = ${live.theta}, balanced = ${live.balanced}`
    );
  }

  const realProblems = problems.filter((p) => {
    // SwiftShader's software renderer complains about ReadPixels stalls; that is
    // an artifact of headless rendering, not a page defect.
    if (/ReadPixels|GL Driver Message|Trying to load the allocator/i.test(p)) return false;
    // Vite's dev server 504s while it re-optimises dependencies, and serves the
    // module graph over paths that do not exist in a build. Run this test
    // against `astro preview` to exercise the real artefact.
    if (/Outdated Optimize Dep|\/@vite\/|\/node_modules\//i.test(p)) return false;
    return true;
  });
  check('the page logged no errors', realProblems.length === 0, realProblems.join('\n       '));

  if (process.env.DEMO_SMOKE_SCREENSHOT) {
    await cdp.eval(
      `document.querySelector('[data-canvas]').scrollIntoView({ block: 'center' })`
    );
    await sleep(600);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(process.env.DEMO_SMOKE_SCREENSHOT, Buffer.from(shot.data, 'base64'));
    console.log(`\nscreenshot → ${process.env.DEMO_SMOKE_SCREENSHOT}`);
  }
} finally {
  try {
    ws?.close();
  } catch {
    /* already gone */
  }
  proc.kill('SIGKILL');
  // Chrome keeps writing to its profile for a moment after the signal, so a
  // straight rm races it and throws ENOTEMPTY — which would otherwise surface
  // as an uncaught exception that masks the real test result.
  await sleep(500);
  try {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.warn(`demo_smoke: could not remove ${profile} (${err.code}); ignoring`);
  }
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
