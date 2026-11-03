// Prebuilt launcher gradients — our own curated palettes brands can pick from (mirrored in
// dashboard/src/lib/gradients.ts for the picker). A bot stores one of:
//   a preset id ("aurora"), "brand" (derived from its primary colour), or "custom:#hex,#hex[,#hex[,#hex]]".
export interface GradientPreset { id: string; name: string; colors: string[] }

export const GRADIENT_PRESETS: GradientPreset[] = [
  { id: 'aurora',   name: 'Aurora',     colors: ['#6366f1', '#22d3ee', '#a78bfa', '#f472b6'] },
  { id: 'sunset',   name: 'Sunset',     colors: ['#fb923c', '#f43f5e', '#a855f7', '#f59e0b'] },
  { id: 'ocean',    name: 'Ocean',      colors: ['#0ea5e9', '#06b6d4', '#3b82f6', '#22d3ee'] },
  { id: 'emerald',  name: 'Emerald',    colors: ['#10b981', '#14b8a6', '#84cc16', '#22d3ee'] },
  { id: 'berry',    name: 'Berry',      colors: ['#db2777', '#9333ea', '#6366f1', '#ec4899'] },
  { id: 'gold',     name: 'Golden hour', colors: ['#f59e0b', '#f97316', '#facc15', '#fb7185'] },
  { id: 'midnight', name: 'Midnight',   colors: ['#4f46e5', '#7c3aed', '#0ea5e9', '#6366f1'] },
  { id: 'mint',     name: 'Mint',       colors: ['#34d399', '#38bdf8', '#a7f3d0', '#818cf8'] },
  { id: 'rose',     name: 'Rose',       colors: ['#fb7185', '#f472b6', '#fda4af', '#c084fc'] },
  { id: 'ink',      name: 'Ink',        colors: ['#111827', '#6b7280', '#9ca3af', '#374151'] },
];

const HEX = /^#[0-9a-fA-F]{6}$/;
export const DEFAULT_GRADIENT = 'aurora';

export function isValidGradient(value: string): boolean {
  if (value === 'brand' || GRADIENT_PRESETS.some((p) => p.id === value)) return true;
  if (!value.startsWith('custom:')) return false;
  const colors = value.slice(7).split(',');
  return colors.length >= 2 && colors.length <= 4 && colors.every((c) => HEX.test(c));
}

/** Mixes a #rrggbb colour towards white (amount > 0) or black (amount < 0). */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  const to = (c: number) => mix(c).toString(16).padStart(2, '0');
  return `#${to(n >> 16)}${to((n >> 8) & 255)}${to(n & 255)}`;
}

/** The concrete colours the widget paints with. Falls back to Aurora for anything unrecognised. */
export function resolveLauncherColors(gradient: string | null | undefined, primaryColor: string | null | undefined): string[] {
  const g = gradient ?? DEFAULT_GRADIENT;
  if (g === 'brand') {
    const p = primaryColor && HEX.test(primaryColor) ? primaryColor : '#4F46E5';
    return [p, shade(p, 0.4), shade(p, -0.2), shade(p, 0.2)];
  }
  if (g.startsWith('custom:') && isValidGradient(g)) return g.slice(7).split(',');
  return (GRADIENT_PRESETS.find((p) => p.id === g) ?? GRADIENT_PRESETS[0]).colors;
}
