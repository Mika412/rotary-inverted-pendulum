// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

const REPO = 'rotary-inverted-pendulum';

export default defineConfig({
  site: `https://ferrolho.github.io`,
  base: `/${REPO}`,
  trailingSlash: 'always',
  // The two test pages were folded into the steps they test. Published URLs
  // outlive the structure, so keep them resolving.
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
        baseUrl: `https://github.com/ferrolho/${REPO}/edit/main/website/`,
      },
      // `katex.min.css` is imported (not linked from a CDN) so Vite emits the
      // stylesheet and its woff2 fonts into the build — same reason the Draco
      // decoder is self-hosted. The site must work offline and without
      // third-party requests.
      customCss: ['./src/styles/custom.css', 'katex/dist/katex.min.css'],
      components: {
        // Wraps Starlight's own PageTitle to put the pipeline step strip above
        // the heading. The strip renders only on pipeline-step routes.
        PageTitle: './src/components/PageTitle.astro',
        // Puts the live demo's 3D stage in the splash hero's image column,
        // which would otherwise render empty. See the file for why.
        Hero: './src/components/Hero.astro',
      },
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
          // Unnumbered on purpose: the numbered sequence below belongs to the
          // runbook, whose step numbers other docs and source comments cite.
          // Two competing "step 0"s in one sidebar just confuses people.
          label: 'Build the rig',
          items: [
            { label: 'Bill of materials', slug: 'build/bom' },
            { label: 'Print the parts', slug: 'build/printing' },
            { label: 'Assemble', slug: 'build/assembly' },
            { label: 'Wire the electronics', slug: 'build/electronics' },
            { label: 'First power-on', slug: 'build/first-power-on' },
          ],
        },
        {
          // Step numbers match the runbook's own, which source comments and
          // other docs refer to ("back to step 2", "step 4b").
          label: 'Train & deploy',
          items: [
            { label: 'The pipeline, end to end', slug: 'train/pipeline' },
            { label: '0. System identification', slug: 'train/sysid' },
            { label: '1. Train the teacher in sim', slug: 'train/sim-training' },
            { label: '2. Fine-tune on the rig', slug: 'train/fine-tune' },
            { label: '3. Distill the student', slug: 'train/distill' },
            { label: '4. Flash and score', slug: 'train/flash' },
            { label: 'Troubleshooting', slug: 'train/troubleshooting' },
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
            { label: 'Mirror symmetry', slug: 'reference/symmetry' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Serial protocols', slug: 'reference/serial-protocol' },
            { label: 'Firmware sketches', slug: 'reference/firmware' },
            { label: 'Python tooling', slug: 'reference/python' },
            { label: 'The URDF and meshes', slug: 'reference/model' },
          ],
        },
      ],
    }),
  ],
  // Display maths is written as $$…$$ and rendered to static HTML+CSS at build
  // time by KaTeX — no client-side JavaScript, and no MathML-only fallback.
  // Used for the reward function and the observation/mirror algebra, which were
  // previously ASCII in code fences where combining diacritics (θ̇) render
  // unreliably. Identifier-heavy pseudocode stays in code fences on purpose.
  markdown: {
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex],
  },
  vite: {
    // The MuJoCo WASM binary is fetched at runtime by the demo island, not
    // bundled — keep Vite from trying to inline or transform it.
    assetsInclude: ['**/*.wasm'],
  },
});
