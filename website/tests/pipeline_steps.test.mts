/**
 * Verify the pipeline step list agrees with the pages and the sidebar.
 *
 * `src/data/pipeline.ts` drives both the full diagram and the strip at the top
 * of every step page. Three things can silently drift out from under it: a page
 * gets renamed (the strip then links to a 404 and highlights nothing), a step is
 * added to the sidebar but not the data (the strip skips it), or the two
 * disagree about order (the strip implies the wrong sequence). None of those
 * fail the build, because Starlight resolves the sidebar and the strip
 * independently.
 *
 *   node tests/pipeline_steps.test.mts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PIPELINE_STEPS, PIPELINE_OVERVIEW_SLUG } from '../src/data/pipeline.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..');
const DOCS = path.join(SITE, 'src/content/docs');

let failures = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`  ok   ${name}`),
      (err: Error) => {
        failures++;
        console.error(`  FAIL ${name}\n       ${err.message}`);
      }
    );
}

/** Resolve a slug to its content file, whichever extension it uses. */
async function pageFor(slug: string): Promise<string | null> {
  for (const ext of ['.md', '.mdx']) {
    const p = path.join(DOCS, slug + ext);
    try {
      await fs.access(p);
      return p;
    } catch {
      /* try the next extension */
    }
  }
  return null;
}

await check('every step has a page', async () => {
  const missing: string[] = [];
  for (const step of PIPELINE_STEPS) {
    if (!(await pageFor(step.slug))) missing.push(step.slug);
  }
  assert.deepEqual(missing, [], `no content file for: ${missing.join(', ')}`);
});

await check('the overview page exists, and is not itself a step', async () => {
  assert.ok(await pageFor(PIPELINE_OVERVIEW_SLUG), `${PIPELINE_OVERVIEW_SLUG} has no page`);
  assert.ok(
    !PIPELINE_STEPS.some((s) => s.slug === PIPELINE_OVERVIEW_SLUG),
    'the overview is listed as a step, so it would carry a strip highlighting nothing'
  );
});

await check('step numbers are 0..n-1, in order', () => {
  const got = PIPELINE_STEPS.map((s) => s.n);
  const want = PIPELINE_STEPS.map((_, i) => String(i));
  assert.deepEqual(got, want, `numbering is ${got.join(',')}`);
});

await check('slugs are unique', () => {
  const slugs = PIPELINE_STEPS.map((s) => s.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'a slug is repeated');
});

await check('the tethered steps come first', () => {
  // The diagram draws one gate from the last tethered step down to the first
  // standalone one; interleaving them would make that single arrow a lie.
  const firstStandalone = PIPELINE_STEPS.findIndex((s) => !s.tethered);
  assert.notEqual(firstStandalone, -1, 'no standalone steps at all');
  assert.ok(
    PIPELINE_STEPS.slice(firstStandalone).every((s) => !s.tethered),
    'tethered and standalone steps are interleaved'
  );
});

await check('the sidebar lists the same steps, in the same order', async () => {
  // The sidebar has to be static for Starlight, so it repeats these slugs.
  // Compare against it rather than trying to import the integration's options.
  const config = await fs.readFile(path.join(SITE, 'astro.config.mjs'), 'utf8');
  const sidebarSlugs = [...config.matchAll(/slug:\s*'([^']+)'/g)].map((m) => m[1]);

  const stepSlugs = PIPELINE_STEPS.map((s) => s.slug);
  const missing = stepSlugs.filter((s) => !sidebarSlugs.includes(s));
  assert.deepEqual(missing, [], `steps absent from the sidebar: ${missing.join(', ')}`);

  const sidebarOrder = sidebarSlugs.filter((s) => stepSlugs.includes(s));
  assert.deepEqual(
    sidebarOrder,
    stepSlugs,
    `sidebar order ${sidebarOrder.join(' → ')} does not match the step order`
  );
});

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
