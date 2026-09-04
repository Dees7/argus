// Turns a raw reasoning-effort value (`high`, `xhigh`, …) into a badge label.
// Dependency-free like `modelFamily.ts`, shared by the extension host and the
// webview.

/**
 * Badge label for an effort value. Unrecognised values keep their raw text
 * capitalised rather than becoming "Unknown" — an effort level Argus has
 * never seen still reads as something rather than nothing.
 */
export function formatEffortLabel(effort: string): string {
  const key = (effort || '').toLowerCase().trim();
  if (!key) return '';
  if (key === 'xhigh') return 'Extra High';
  return key.charAt(0).toUpperCase() + key.slice(1);
}
