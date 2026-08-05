/**
 * Verify every local asset the built pages reference actually ships.
 *
 * A broken <img> does not fail an Astro build: the tag is copied through
 * verbatim and only 404s in the visitor's browser. That is how the wiring
 * diagram on the electronics page pointed at the repository-root `diagrams/`
 * folder — a path that exists in the repo but never in `dist/` — and stayed
 * broken silently.
 *
 * Runs against `dist/`, so it checks what is actually published, including
 * assets `scripts/prepare.mjs` copies in at build time.
 *
 *   npm run build && node tests/doc_assets.test.mts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../dist');
const BASE = '/rotary-inverted-pendulum';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`);
    if (detail) console.log(`       ${detail}`);
  }
}

async function htmlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await htmlFiles(full)));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

try {
  await fs.access(DIST);
} catch {
  console.log('dist/ not found — run `npm run build` first');
  process.exit(1);
}

const pages = await htmlFiles(DIST);
check('the site built some pages', pages.length > 0, `${pages.length} html files`);

// src/href values worth checking: same-origin paths that should resolve to a
// file in dist. Skips external URLs, data URIs, anchors and mailto.
const broken: string[] = [];
let checked = 0;

for (const page of pages) {
  const html = await fs.readFile(page, 'utf8');
  const refs = [...html.matchAll(/<(?:img|source)\b[^>]*?\ssrc="([^"]+)"/g)].map((m) => m[1]);

  for (const ref of refs) {
    if (/^(https?:|data:|mailto:|#|\/\/)/.test(ref)) continue;
    checked += 1;

    // Resolve to a path inside dist: absolute refs carry the base prefix,
    // relative ones resolve against the page's own directory.
    const rel = ref.startsWith('/')
      ? ref.startsWith(`${BASE}/`)
        ? ref.slice(BASE.length + 1)
        : ref.slice(1)
      : path.relative(DIST, path.resolve(path.dirname(page), ref));

    try {
      await fs.access(path.join(DIST, rel.split('?')[0].split('#')[0]));
    } catch {
      broken.push(`${path.relative(DIST, page)} → ${ref}`);
    }
  }
}

check(
  'every local image reference resolves in dist',
  broken.length === 0,
  broken.join('\n       ')
);
check('the check actually looked at something', checked > 0, `${checked} references`);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
