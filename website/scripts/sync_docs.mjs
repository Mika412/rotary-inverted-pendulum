/**
 * Sync canonical markdown into the Starlight content collection.
 *
 * `docs/*.md` stays the single source of truth: it is referenced by CLAUDE.md,
 * by both READMEs, and by ~25 source comments, and it must stay readable on
 * GitHub without frontmatter noise. So instead of moving those files into the
 * site, this script copies them in at build time and injects the frontmatter
 * Starlight needs, rewriting inter-document links to the site's URLs.
 *
 * Generated outputs are gitignored and listed explicitly in website/.gitignore.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// fileURLToPath, not `new URL(...).pathname` — this repo's path contains spaces,
// which the URL pathname percent-encodes into a path that does not exist.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..');
const REPO = path.resolve(SITE, '..');
const OUT = path.join(SITE, 'src/content/docs');

/**
 * source            — path relative to the repo root
 * slug              — Starlight slug (also the output path under src/content/docs)
 * title/description — injected frontmatter; the source files start with an H1
 *                     which we strip, since Starlight renders the title itself.
 */
export const PAGES = [
  {
    source: 'docs/BOM.md',
    slug: 'build/bom',
    title: 'Bill of materials',
    description: 'Every part needed to build the rig, with prices and sourcing notes.',
    sidebarOrder: 0,
  },
  {
    source: 'docs/3d_printing.md',
    slug: 'build/printing',
    title: 'Print the parts',
    description: 'Print settings and orientation for the base, arm, lid and pendulum.',
  },
  {
    source: 'docs/electronics_design.md',
    slug: 'build/electronics',
    title: 'Wire the electronics',
    description:
      'Driver choice, current limiting, wiring gotchas and the full schematic for the stepper, encoder and Nano.',
  },
  {
    source: 'docs/end_to_end_runbook.md',
    slug: 'train/pipeline',
    title: 'The pipeline, end to end',
    description:
      'How to take a freshly-built rig from no policy at all to balancing standalone on the Nano.',
  },
  {
    source: 'docs/sysid_runbook.md',
    slug: 'train/sysid',
    title: 'System identification',
    description: 'Measuring the friction parameters that pin the simulation to your rig.',
  },
  {
    source: 'docs/rl_transitions.md',
    slug: 'reference/transitions',
    title: 'The transition contract',
    description: 'What a single (s, a, r, s′) transition means in this system, in plain English.',
  },
  {
    source: 'docs/domain_randomization.md',
    slug: 'reference/domain-randomization',
    title: 'Domain randomization',
    description: 'What is randomized during training, by how much, and why.',
  },
  {
    source: 'docs/transport_delay.md',
    slug: 'reference/transport-delay',
    title: 'Transport delay',
    description:
      'Measured action-delay history and the decision log behind the hardware and firmware changes.',
  },
  {
    source: 'docs/async_control_architecture.md',
    slug: 'reference/async-control',
    title: 'Async control runtime',
    description: 'The threaded runtime that holds the control rate during fine-tuning.',
  },
  {
    source: 'docs/control_rate_selection.md',
    slug: 'reference/control-rate',
    title: 'Choosing the control rate',
    description: 'How to pick the control frequency and action limits from sysid measurements.',
  },
  {
    source: 'RotaryInvertedPendulum-arduino/PIDControl/TUNING_HISTORY.md',
    slug: 'reference/pid-tuning-history',
    title: 'PID tuning history',
    description: 'The hand-tuned PID controller that preceded the learned policy.',
  },
];

/** Map a repo-relative markdown path to its site URL path, for link rewriting. */
const SLUG_BY_SOURCE = new Map(PAGES.map((p) => [p.source, p.slug]));

const BASE = '/rotary-inverted-pendulum';

/**
 * Rewrite links that pointed at sibling markdown files so they resolve on the
 * site. Anything we do not publish (source files, meshes, diagrams) is pointed
 * at GitHub instead, so no link silently 404s.
 */
function rewriteLinks(body, sourcePath) {
  const sourceDir = path.posix.dirname(sourcePath);
  const GITHUB = 'https://github.com/ferrolho/rotary-inverted-pendulum/blob/main';

  return body.replace(/\]\(([^)\s]+?)(#[^)\s]*)?\)/g, (match, target, anchor = '') => {
    // Leave absolute URLs, mailto and in-page anchors alone.
    if (/^([a-z]+:|\/\/|#)/i.test(target)) return match;

    // Resolve the link relative to the source file's directory.
    const resolved = path.posix.normalize(path.posix.join(sourceDir, target));

    const slug = SLUG_BY_SOURCE.get(resolved);
    if (slug) return `](${BASE}/${slug}/${anchor})`;

    // Not a published page — send it to the file on GitHub.
    return `](${GITHUB}/${resolved}${anchor})`;
  });
}

function yamlString(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export async function syncDocs({ quiet = false } = {}) {
  const results = [];

  for (const page of PAGES) {
    const abs = path.join(REPO, page.source);
    let raw;
    try {
      raw = await fs.readFile(abs, 'utf8');
    } catch (err) {
      throw new Error(
        `sync_docs: cannot read ${page.source} — the canonical file moved or was renamed. ` +
          `Update PAGES in website/scripts/sync_docs.mjs. (${err.code})`
      );
    }

    // Strip the leading H1: Starlight renders `title` as the page heading, so
    // keeping it would show the title twice.
    let body = raw.replace(/^\s*#\s+.*\r?\n+/, '');
    body = rewriteLinks(body, page.source);

    const frontmatter = [
      '---',
      '# AUTO-GENERATED — do not edit.',
      `# Source of truth: ${page.source}`,
      '# Regenerate with: node website/scripts/prepare.mjs',
      `title: ${yamlString(page.title)}`,
      `description: ${yamlString(page.description)}`,
      ...(page.sidebarOrder !== undefined
        ? ['sidebar:', `  order: ${page.sidebarOrder}`]
        : []),
      'editUrl: ' +
        yamlString(`https://github.com/ferrolho/rotary-inverted-pendulum/edit/main/${page.source}`),
      '---',
      '',
    ].join('\n');

    const outPath = path.join(OUT, `${page.slug}.md`);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, frontmatter + body, 'utf8');
    results.push({ ...page, bytes: body.length });
  }

  if (!quiet) {
    console.log(`sync_docs: ${results.length} pages synced from canonical sources`);
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await syncDocs();
}
