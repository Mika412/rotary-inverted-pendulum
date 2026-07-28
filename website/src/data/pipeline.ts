/**
 * The pipeline's steps — the one place they are defined.
 *
 * Two components render this list: `PipelineDiagram.astro` (the full diagram on
 * the overview page) and `PipelineNav.astro` (the compact strip at the top of
 * every step page). They must agree on the order, the numbering and the slugs,
 * or the strip would highlight the wrong step. The sidebar in `astro.config.mjs`
 * repeats the same labels because Starlight needs them statically; that one is
 * checked by `tests/pipeline_steps.test.mts`.
 */

export interface PipelineStep {
  /** Step number as displayed. A string because it is a label, not an index. */
  n: string;
  /** Short name, used in the diagram and the nav strip. */
  title: string;
  /** One-line elaboration. Diagram only — the strip has no room for it. */
  sub: string;
  /**
   * Label for the compact strip, where seven chips share one narrow content
   * column. Omit when `title` is already short enough. The step number sits
   * next to it, so these can be terser than the diagram's labels.
   */
  short?: string;
  /** Docs slug, matching `Astro.locals.starlightRoute.id` on that page. */
  slug: string;
  /**
   * Whether the step still needs the laptop attached. Steps 4–6 exist only to
   * remove the tether, which is why the diagram groups and labels them.
   */
  tethered: boolean;
}

export const PIPELINE_STEPS: PipelineStep[] = [
  { n: '0', title: 'sysid', sub: 'measure the rig', slug: 'train/sysid', tethered: true },
  {
    n: '1',
    title: 'train in sim',
    short: 'sim',
    sub: 'curriculum, ~25 min',
    slug: 'train/sim-training',
    tethered: true,
  },
  {
    n: '2',
    title: 'fine-tune',
    sub: 'on the real rig',
    slug: 'train/fine-tune',
    tethered: true,
  },
  {
    n: '3',
    title: 'test teacher',
    short: 'teacher',
    sub: 'tethered',
    slug: 'train/test-teacher',
    tethered: true,
  },
  {
    n: '4',
    title: 'distill',
    sub: 'shrink the student',
    slug: 'train/distill',
    tethered: false,
  },
  {
    n: '5',
    title: 'test student',
    short: 'student',
    sub: 'tethered, optional',
    slug: 'train/test-student',
    tethered: false,
  },
  {
    n: '6',
    title: 'flash + score',
    short: 'flash',
    sub: 'standalone on the Nano',
    slug: 'train/flash',
    tethered: false,
  },
];

/** The slug of the page carrying the full diagram, where the strip is redundant. */
export const PIPELINE_OVERVIEW_SLUG = 'train/pipeline';

export const tetheredSteps = PIPELINE_STEPS.filter((s) => s.tethered);
export const standaloneSteps = PIPELINE_STEPS.filter((s) => !s.tethered);
