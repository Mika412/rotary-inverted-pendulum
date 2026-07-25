// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const REPO = 'rotary-inverted-pendulum';

// The runbook is one canonical file (docs/end_to_end_runbook.md, referenced by
// CLAUDE.md and by source comments), but the *navigation* is step-shaped: each
// sidebar entry deep-links to that page's step heading. This gives the guided
// path the runbook describes without fragmenting the single source of truth.
const PIPELINE = '/train/pipeline/';

export default defineConfig({
  site: `https://ferrolho.github.io`,
  base: `/${REPO}`,
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Rotary Inverted Pendulum',
      description:
        'A £20 DIY rotary inverted pendulum that balances itself with a reinforcement-learning policy — trained in simulation, fine-tuned on the real rig, and distilled to 689 parameters running standalone on an Arduino Nano.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: `https://github.com/ferrolho/${REPO}`,
        },
        {
          icon: 'youtube',
          label: 'Build video',
          href: 'https://www.youtube.com/watch?v=rKChjuuR7K8',
        },
      ],
      editLink: {
        baseUrl: `https://github.com/ferrolho/${REPO}/edit/main/`,
      },
      customCss: ['./src/styles/custom.css'],
      // Pages are synced from docs/ at build time; point the edit link and
      // "last updated" at the canonical files rather than the generated copies.
      lastUpdated: true,
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'What you are building', slug: 'start/overview' },
            { label: 'Buy instead of build?', slug: 'start/buy-or-build' },
          ],
        },
        {
          label: 'Build the rig',
          items: [
            { label: '0 · Bill of materials', slug: 'build/bom' },
            { label: '1 · Print the parts', slug: 'build/printing' },
            { label: '2 · Assemble', slug: 'build/assembly' },
            { label: '3 · Wire the electronics', slug: 'build/electronics' },
            { label: '4 · First power-on', slug: 'build/first-power-on' },
          ],
        },
        {
          label: 'Train & deploy',
          items: [
            { label: 'The pipeline, end to end', slug: 'train/pipeline' },
            { label: '5 · System identification', link: `${PIPELINE}#0-system-identification--measure-the-rig` },
            { label: '6 · Train the teacher in sim', link: `${PIPELINE}#1-train-the-teacher-in-sim--curriculum` },
            { label: '7 · Fine-tune on the rig', link: `${PIPELINE}#2-fine-tune-on-the-real-rig--async` },
            { label: '8 · Test the teacher', link: `${PIPELINE}#3-test-the-teacher-on-the-rig--tethered` },
            { label: '9 · Distill the student', link: `${PIPELINE}#4-distill--shrink-the-actor-for-the-deployment-transport` },
            { label: '10 · Flash & score standalone', link: `${PIPELINE}#6-flash-the-standalone-sketch--remove-the-tether` },
            { label: 'Sysid procedure', slug: 'train/sysid' },
          ],
        },
        {
          label: 'How it works',
          items: [
            { label: 'The transition contract', slug: 'reference/transitions' },
            { label: 'Domain randomization', slug: 'reference/domain-randomization' },
            { label: 'Transport delay', slug: 'reference/transport-delay' },
            { label: 'Async control runtime', slug: 'reference/async-control' },
            { label: 'Choosing the control rate', slug: 'reference/control-rate' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Serial protocols', slug: 'reference/serial-protocol' },
            { label: 'Firmware sketches', slug: 'reference/firmware' },
            { label: 'Python tooling', slug: 'reference/python' },
            { label: 'Julia stack (MPC/LQR)', slug: 'reference/julia' },
            { label: 'PID tuning history', slug: 'reference/pid-tuning-history' },
          ],
        },
      ],
    }),
  ],
  vite: {
    // The MuJoCo WASM binary is fetched at runtime by the demo island, not
    // bundled — keep Vite from trying to inline or transform it.
    assetsInclude: ['**/*.wasm'],
  },
});
