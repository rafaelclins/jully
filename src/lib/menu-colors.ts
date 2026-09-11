const HEX_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normalizeHexColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!HEX_COLOR_PATTERN.test(trimmed)) return null;
  const hex = trimmed.toLowerCase();
  if (hex.length === 4) {
    const [, r, g, b] = hex;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return hex;
}

function channelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const r = channelToLinear(parseInt(hex.slice(1, 3), 16));
  const g = channelToLinear(parseInt(hex.slice(3, 5), 16));
  const b = channelToLinear(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function readableTextColor(hex: string): string {
  return relativeLuminance(hex) > 0.179 ? "#1c1917" : "#ffffff";
}

export const BRAND_FALLBACK = {
  primary: "#18181b",
  secondary: "#3f3f46",
} as const;

export type BrandColors = {
  primary: string;
  secondary: string;
  onPrimary: string;
};

export function resolveBrandColors(
  primaryColor: string | null,
  secondaryColor: string | null
): BrandColors {
  const primary = normalizeHexColor(primaryColor) ?? BRAND_FALLBACK.primary;
  const secondary = normalizeHexColor(secondaryColor) ?? BRAND_FALLBACK.secondary;
  return {
    primary,
    secondary,
    onPrimary: readableTextColor(primary),
  };
}