// Single source of truth for turning a raw model id into the family Argus
// filters, groups and labels by. Shared by the extension host and the webview,
// so deliberately dependency-free like `pricing.ts`.
//
// Nothing here is a fixed list of models: the family is derived from the id, so
// a model Argus has never seen (`glm-5-2`, `gpt-5-codex`) gets its own filter
// entry instead of falling into "unknown".

/**
 * Ids are written `<vendor>-<family>-<version…>`, and only for these vendors is
 * the first segment a vendor rather than the family itself. Stripping it is
 * what makes `claude-opus-5` an "Opus" session and not a "Claude" one.
 */
const VENDOR_SEGMENTS = new Set(['claude', 'anthropic']);

export interface ModelFamily {
  /** Filter and grouping key, e.g. `opus`, `glm`. `unknown` when unusable. */
  key: string;
  /** Short badge label, e.g. `Opus`, `GLM`. */
  label: string;
  /** Vendor stripped off the id, e.g. `Claude`. Empty when the id had none. */
  vendor: string;
}

const UNKNOWN: ModelFamily = { key: 'unknown', label: 'Unknown', vendor: '' };

/** `glm` -> `GLM`, `opus` -> `Opus`, `kimi-k2` -> `Kimi K2`. */
function humanize(key: string): string {
  return key
    .split('-')
    .map(part =>
      // Short or vowel-less parts read as acronyms (GLM, GPT, K2); the rest as
      // names.
      part.length <= 3 || !/[aeiou]/.test(part)
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join(' ');
}

export function modelFamily(model: string): ModelFamily {
  const id = (model || '').toLowerCase().trim();
  // `<synthetic>` marks messages Claude Code wrote itself, never a real model.
  if (!id || id === 'unknown' || id.startsWith('<')) {
    return UNKNOWN;
  }

  // Provider-routed ids arrive as `anthropic/claude-opus-5`; keep the model.
  const segments = id.split('/').pop()!.split(/[-_.]/).filter(Boolean);
  let vendor = '';
  if (segments.length > 1 && VENDOR_SEGMENTS.has(segments[0])) {
    vendor = segments.shift()!;
  }

  // The family is the first segment that is not a version or a date. Scanning
  // past them rather than stopping at the first one is what keeps
  // `claude-4.7-opus-20260416` an Opus session, since ids put the version
  // before the family as often as after it.
  const key = segments.find(segment => !/^v?\d/.test(segment)) || vendor;
  if (!key) {
    return UNKNOWN;
  }
  return { key, label: humanize(key), vendor: vendor ? humanize(vendor) : '' };
}

/** Filter/group key for a model id. */
export function modelFamilyKey(model: string): string {
  return modelFamily(model).key;
}

/**
 * Badge label for a model id. Unrecognisable ids keep their raw text rather
 * than becoming "Unknown", so nothing an id carries is lost in the UI.
 */
export function formatModelLabel(model: string): string {
  const family = modelFamily(model);
  return family.key === 'unknown' ? model || '' : family.label;
}

/** Group heading for a family key, e.g. `opus` -> `Claude Opus`. */
export function modelGroupLabel(family: ModelFamily): string {
  if (family.key === 'unknown') {
    return 'Unknown Model';
  }
  return family.vendor ? `${family.vendor} ${family.label}` : family.label;
}

export interface ModelFilterOption {
  key: string;
  label: string;
}

/**
 * The families actually present in the given sessions, alphabetical, with
 * `unknown` last. Drives the model dropdown so it only ever offers filters
 * that can match something.
 */
export function collectModelFilterOptions(models: string[]): ModelFilterOption[] {
  const byKey = new Map<string, ModelFilterOption>();
  for (const model of models) {
    const family = modelFamily(model);
    if (!byKey.has(family.key)) {
      byKey.set(family.key, { key: family.key, label: family.label });
    }
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.key === 'unknown') return 1;
    if (b.key === 'unknown') return -1;
    return a.label.localeCompare(b.label);
  });
}
