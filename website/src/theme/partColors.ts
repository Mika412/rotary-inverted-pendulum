export type PartGroup = 'body' | 'arm' | 'pendulum';

/**
 * How a printed part is finished, per scene.
 *
 * The two scenes are lit very differently — the front-page demo has three
 * explicit lights and no environment, the build guide has a room environment
 * with the direct lights held low — so the same filament needs different base
 * colours to read the same way. They are deliberately not one palette, and
 * keeping them side by side here is what makes that legible; with the guide's
 * table living in `assembly/parts.ts`, the picker's "default" swatch offered a
 * colour the guide never rendered.
 */
export interface PartFinish {
  color: number;
  roughness: number;
  metalness: number;
}

/** Front-page demo: three hard lights, no environment. */
export const DEMO_FINISH: Record<string, PartFinish> = {
  base: { color: 0x2f3542, roughness: 0.85, metalness: 0.05 },
  lid: { color: 0x3d4454, roughness: 0.85, metalness: 0.05 },
  arm: { color: 0x4a90d9, roughness: 0.6, metalness: 0.1 },
  pendulum: { color: 0xe8503a, roughness: 0.5, metalness: 0.15 },
};

/** Build guide: room environment, low direct light, and a fifth part on show. */
export const TUTORIAL_FINISH: Record<string, PartFinish> = {
  base: { color: 0x59637a, roughness: 0.85, metalness: 0.0 },
  lid: { color: 0x66708a, roughness: 0.85, metalness: 0.0 },
  arm: { color: 0x3f8fe0, roughness: 0.5, metalness: 0.0 },
  pendulum: { color: 0xf05437, roughness: 0.45, metalness: 0.0 },
  'motor plate': { color: 0x8189a0, roughness: 0.8, metalness: 0.0 },
};

/** The colours alone, which is what the picker resets to. */
export function defaultColors(finish: Record<string, PartFinish>): Record<string, number> {
  return Object.fromEntries(Object.entries(finish).map(([k, v]) => [k, v.color]));
}

export const PART_GROUPS: Record<PartGroup, string[]> = {
  body: ['base', 'lid'],
  arm: ['arm'],
  pendulum: ['pendulum'],
};

export const GROUP_LABELS: Record<PartGroup, string> = {
  body: 'Body',
  arm: 'Arm',
  pendulum: 'Pendulum',
};

export const GROUP_ORDER: PartGroup[] = ['body', 'arm', 'pendulum'];

export type PartColors = Partial<Record<PartGroup, string>>;

const STORAGE_KEY = 'rip-part-colours';
const HEX = /^#[0-9a-f]{6}$/i;

const listeners = new Set<(colors: PartColors) => void>();
let current: PartColors | null = null;

function parseColor(value: unknown): string | null {
  return typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : null;
}

function read(): PartColors {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: PartColors = {};
    for (const group of GROUP_ORDER) {
      const hex = parseColor(parsed[group]);
      if (hex) out[group] = hex;
    }
    return out;
  } catch {
    return {};
  }
}

function write(colors: PartColors): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (Object.keys(colors).length) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* private mode, or the quota is full — the colours just will not persist */
  }
}

export function getColors(): PartColors {
  if (!current) current = read();
  return { ...current };
}

export function groupOf(mesh: string): PartGroup | null {
  for (const group of GROUP_ORDER) {
    if (PART_GROUPS[group].includes(mesh)) return group;
  }
  return null;
}

export function colorOf(mesh: string): string | null {
  const group = groupOf(mesh);
  return group ? (getColors()[group] ?? null) : null;
}

function publish(next: PartColors): void {
  current = next;
  for (const listener of listeners) listener({ ...next });
}

export function setColor(group: PartGroup, hex: string): void {
  if (!HEX.test(hex)) return;
  const next = { ...getColors(), [group]: hex.toLowerCase() };
  write(next);
  publish(next);
}

export function reset(): void {
  write({});
  publish({});
}

export function subscribe(listener: (colors: PartColors) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    current = null;
    publish(read());
  });
}
