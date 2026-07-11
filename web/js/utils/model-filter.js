//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Model filtering utilities for identifying recommended models.
 *
 * The shortlist is **lineage-aware generation curation**. Rather than scoring
 * every model independently and picking a fixed number of "best" ones, models
 * are grouped into lineages — a product line that persists across version
 * bumps, e.g. the `gpt-5.x` flagship line, the `*-codex` coding line, the
 * `*-mini` budget line, or the `glm-4.x` line. Within each lineage only the
 * newest generation (and, when it's a close minor bump, the one before it) is
 * kept, and ALL sibling variants of a kept generation survive together.
 *
 * That single rule fixes what the old category-bucket scorer got wrong:
 *   - Same-generation siblings (e.g. gpt-5.6-sol / -terra / -luna) are all
 *     kept, instead of one winning its bucket and the rest being discarded.
 *   - Superseded generations in the same lineage (gpt-5.1, gpt-5.2, gpt-4o
 *     once gpt-5.6 exists) are dropped, instead of leaking in as filler.
 *   - A short-but-multi-generation list (z.ai's ~8 GLM models) is still
 *     trimmed to the current couple of versions, instead of being shown whole.
 *
 * A final per-brand cap then limits each brand (gpt, glm, o, gemini …) to its
 * {@link MAX_VERSIONS_PER_BRAND} most-recent versions across ALL its lineages,
 * so a brand never shows a long tail of point-releases even when lagging
 * sub-lines (an old `-mini`, `-codex`, or `-pro`) each survive their own
 * lineage. {@link sortModelsByVersion} sorts a full model list newest-first for
 * display when the provider returns them in no meaningful order.
 */

/**
 * Lists at or below this size are shown in full rather than curated — with only
 * a handful of models there is nothing to hide, and curation would risk
 * dropping a line the user actually wants. Above it, curation earns its keep.
 */
const MIN_CURATE_SIZE = 4;

/**
 * The most versions of one brand the shortlist ever shows. After per-lineage
 * curation, each brand is capped to its this-many newest distinct versions, so
 * the flagship line and any budget/coding sub-lines together never contribute
 * more than a couple of version numbers. A sub-line lagging further behind than
 * this (e.g. a `gpt-5.2-codex` when the brand is already on 5.6/5.5) drops out
 * rather than padding the list with stale versions.
 */
const MAX_VERSIONS_PER_BRAND = 2;

/**
 * Keep the second-newest generation of a lineage only when it is a *close*
 * predecessor of the newest: the same integer major, no more than this far
 * behind in minor version. So glm-4.7 keeps glm-4.6 (0.1 back) and gpt-5.6
 * keeps a gpt-5.5, but gpt-5.6 drops gpt-5.2 (0.4 back — a big gap) and a major
 * bump (glm-5.0 over glm-4.7) shows only the new major. Anything older than the
 * second kept generation is always dropped.
 */
const GENERATION_GAP = 0.2;

/**
 * Budget-tier tokens: faster/cheaper variants that form their own lineage so
 * the cheap option survives alongside the flagship (gemini-flash vs -pro,
 * glm-air vs the full model) rather than being outranked out of the shortlist.
 */
const BUDGET_SUFFIXES = ['mini', 'nano', 'lite', 'air', 'flash'];

/**
 * Qualifier tokens that define a distinct lineage (a separate line the user
 * picks between), as opposed to a per-generation codename. A trailing token in
 * this set splits the lineage (so `*-codex` and `*-mini` are curated on their
 * own); any other trailing token (sol, terra, luna, a date, an internal id) is
 * treated as a sibling variant within one generation and kept together.
 */
const LINEAGE_QUALIFIERS = new Set([...BUDGET_SUFFIXES, 'codex']);

/**
 * @typedef {object} Model
 * @property {string} id - The raw model id from the provider.
 * @property {string} [displayName] - Optional human-readable label.
 */

/**
 * A model annotated with its parsed lineage, generation, and original position.
 * @typedef {object} Annotated
 * @property {Model} model - The original model object.
 * @property {string} id - The model id (copied for helper convenience).
 * @property {string} key - The lineage key this model groups under.
 * @property {string} brand - The brand prefix (lineage key without qualifiers), used for the per-brand version cap.
 * @property {number} generation - The parsed version/generation number.
 * @property {number} order - The model's index in the input list (for stable sorting).
 */

/**
 * Filter models to the recommended shortlist: the current generation (and a
 * close predecessor) of each lineage, all variants included, newest first.
 * @param {Model[]} models - All models from provider
 * @returns {Model[]} Recommended models, sorted newest-first
 */
export function getRecommendedModels(models) {
  // Too few to be worth hiding any — show the list as-is.
  if (models.length <= MIN_CURATE_SIZE) {
    return models;
  }

  // Drop specialized/non-chat models (transcribe, tts, image, …).
  const chatModels = models.filter(m => !isSpecializedModel(m.id));
  if (chatModels.length === 0) return models; // Fallback if the filter is too aggressive.

  // Annotate each model with its lineage key and parsed generation, keeping the
  // original index so ties preserve the provider's API order in the final sort.
  const annotated = chatModels.map((model, order) => {
    const { key, generation } = parseLineage(model.id);
    const brand = key.split('|')[0] || key; // Lineage key strips to just the brand prefix.
    return { model, id: model.id, key, brand, generation, order };
  });

  // Group by lineage, then curate each lineage down to its current generation(s).
  /** @type {Map<string, Annotated[]>} */
  const lineages = new Map();
  for (const entry of annotated) {
    const bucket = lineages.get(entry.key);
    if (bucket) bucket.push(entry);
    else lineages.set(entry.key, [entry]);
  }

  /** @type {Annotated[]} */
  const kept = [];
  for (const bucket of lineages.values()) {
    kept.push(...curateLineage(bucket));
  }

  if (kept.length === 0) return models; // Fallback: never hand back an empty shortlist.

  // Per-brand version cap: across all lineages of a brand, keep only models
  // whose generation is one of its MAX_VERSIONS_PER_BRAND newest versions — so
  // a lagging sub-line (an old -mini/-codex) can't pad the list with stale
  // point-releases the user would never pick.
  /** @type {Map<string, Set<number>>} */
  const brandVersions = new Map();
  for (const entry of kept) {
    const versions = brandVersions.get(entry.brand) ?? new Set();
    versions.add(entry.generation);
    brandVersions.set(entry.brand, versions);
  }
  for (const [brand, versions] of brandVersions) {
    const newest = [...versions].sort((a, b) => b - a).slice(0, MAX_VERSIONS_PER_BRAND);
    brandVersions.set(brand, new Set(newest));
  }
  const capped = kept.filter(entry => brandVersions.get(entry.brand)?.has(entry.generation));

  // Sort newest generation first; equal generations keep API order (stable).
  capped.sort((a, b) => b.generation - a.generation || a.order - b.order);

  return capped.map(entry => entry.model);
}

/**
 * Sort a full model list newest-first by parsed version, for display when the
 * provider hands them back in no meaningful order (OpenAI and Gemini list
 * roughly at random). Returns a new array; stable for equal versions, so
 * same-version variants and unparseable/specialized models keep their API order
 * amongst themselves (the latter sinking to the bottom as version 0).
 * @param {Model[]} models - The full model list from a provider.
 * @returns {Model[]} A new array sorted newest-first.
 */
export function sortModelsByVersion(models) {
  return models
    .map((model, order) => ({ model, order, generation: extractVersion(model.id) }))
    .sort((a, b) => b.generation - a.generation || a.order - b.order)
    .map(entry => entry.model);
}

/**
 * Curate one lineage to its current generation(s): always the newest, plus the
 * second-newest when it is a close predecessor (same major, within
 * GENERATION_GAP). Within each kept generation, drop preview and dated variants
 * when a stable/undated sibling exists, but keep every remaining variant.
 * @param {Annotated[]} entries
 * @returns {Annotated[]} Survivors.
 */
function curateLineage(entries) {
  const generations = [...new Set(entries.map(e => e.generation))].sort((a, b) => b - a);
  const newest = generations[0];
  if (newest === undefined) return entries; // Unreachable (callers pass non-empty buckets).
  const keptGenerations = new Set([newest]);

  const second = generations[1];
  if (
    second !== undefined &&
    Math.trunc(second) === Math.trunc(newest) &&
    newest - second <= GENERATION_GAP
  ) {
    keptGenerations.add(second);
  }

  // Within each surviving generation, prefer stable over preview and undated
  // over dated — but only as a filter, never below one model, so genuine
  // sibling variants (sol/terra/luna) all remain.
  /** @type {Map<number, Annotated[]>} */
  const byGeneration = new Map();
  for (const entry of entries) {
    if (!keptGenerations.has(entry.generation)) continue;
    const bucket = byGeneration.get(entry.generation);
    if (bucket) bucket.push(entry);
    else byGeneration.set(entry.generation, [entry]);
  }

  /** @type {Annotated[]} */
  const survivors = [];
  for (const bucket of byGeneration.values()) {
    let group = bucket;
    const stable = group.filter(e => !isPreviewModel(e.id));
    if (stable.length > 0) group = stable;
    const undated = group.filter(e => !hasDateSuffix(e.id));
    if (undated.length > 0) group = undated;
    survivors.push(...group);
  }
  return survivors;
}

/**
 * Parse a model id into its lineage key and generation number.
 *
 * The lineage key is the brand prefix plus any lineage-defining qualifiers
 * (codex, budget tiers), with the version number and per-generation codenames
 * stripped — so every generation of one product line shares a key, while
 * distinct lines (codex, mini) get their own. The generation is the numeric
 * version (see {@link extractVersion}).
 *
 * Examples: `gpt-5.6-sol` → {key: "gpt", gen: 5.6}; `gpt-5.6-terra` → same key;
 * `gpt-4o` → {key: "gpt", gen: 4} (older generation, same lineage);
 * `gpt-5.6-codex` → {key: "gpt|codex", gen: 5.6}; `o4-mini` → {key: "o|mini",
 * gen: 4}; `glm-4.5-air` → {key: "glm|air", gen: 4.5}.
 * @param {string} modelId
 * @returns {{key: string, generation: number}} Lineage key and generation.
 */
function parseLineage(modelId) {
  const generation = extractVersion(modelId);

  const cleaned = modelId.toLowerCase()
    .replace(/^models\//, '')
    .replace(DATE_SUFFIX, ''); // strip a trailing date so it isn't a "qualifier"
  const tokens = cleaned.split('-').filter(Boolean);

  // The version token is the first token carrying a digit (5.6, 4o, o3, 4).
  // A pure-integer minor (the "1" of claude-opus-4-1) trails the major token
  // and is not itself a lineage qualifier, so it drops out with the codenames.
  const versionIndex = tokens.findIndex(t => /\d/.test(t));
  const versionToken = versionIndex === -1 ? undefined : tokens[versionIndex];
  if (versionToken === undefined) {
    return { key: tokens.join('-'), generation };
  }

  // Brand = words before the version token, plus any leading letters of the
  // version token itself ("o" of "o3"). Trailing letters ("o" of "4o") belong
  // to the version, not the brand, so gpt-4o stays in the gpt lineage.
  const leadingAlpha = (versionToken.match(/^[a-z]+/) || [''])[0];
  const brand = [...tokens.slice(0, versionIndex), leadingAlpha].filter(Boolean).join('-');

  // Keep only lineage-defining qualifiers after the version; everything else
  // (codenames, sizes like 32b, internal ids) collapses into the generation.
  const qualifiers = tokens
    .slice(versionIndex + 1)
    .filter(t => LINEAGE_QUALIFIERS.has(t))
    .sort();

  return { key: [brand, ...qualifiers].join('|'), generation };
}

/**
 * Check if model is specialized (transcribe, tts, image, etc.)
 * NOTE: codex variants are PREFERRED for coding (not excluded)
 * @param {string} modelId
 * @returns {boolean} True if model is specialized for non-chat tasks
 */
function isSpecializedModel(modelId) {
  const specialized = [
    'transcribe', 'tts', 'audio', 'realtime', 'diarize',
    'search', 'image', 'sora', 'chat',
    'computer-use', 'robotics', 'deep-research',
    'nano-banana', // Weird Google model
    'gemma' // Google's open-source models (not commercial API)
    // NOT 'codex' - these are code-optimized and good for Juggler!
  ];

  const lower = modelId.toLowerCase();
  return specialized.some(suffix => lower.includes(suffix));
}

/**
 * Check if model is preview/experimental
 * @param {string} modelId
 * @returns {boolean} True if model is preview/experimental
 */
function isPreviewModel(modelId) {
  const lower = modelId.toLowerCase();
  // Match as whole word-components between hyphens, not arbitrary substrings
  const parts = lower.split('-');
  const previewParts = ['preview', 'exp', 'experimental'];
  return parts.some(part => previewParts.includes(part));
}

/**
 * A trailing release date, in either the hyphenated `YYYY-MM-DD` form or the
 * bare `YYYYMMDD` form Anthropic appends (e.g. `-20250805`). Anchored to the end
 * so it only matches a genuine suffix, never a version like `glm-4-32b-0414`.
 */
const DATE_SUFFIX = /-?\d{4}-?\d{2}-?\d{2}$/;

/**
 * A pure parameter-count token — `32b`, `9b`, `1.5b`, `120m` — a model *size*,
 * not a version. Used to keep {@link extractVersion} from reading `9b` as v9.
 */
const PARAM_SIZE_TOKEN = /^\d+(?:\.\d+)?[bm]$/;

/**
 * Check if model has a date suffix (YYYY-MM-DD or YYYYMMDD).
 * @param {string} modelId
 * @returns {boolean} True if model has date suffix
 */
function hasDateSuffix(modelId) {
  return DATE_SUFFIX.test(modelId);
}

/**
 * Extract the version number from a model id, coping with every shape the
 * vendors use to write it:
 *   - dotted, e.g. gpt-5.6 → 5.6, gemini-2.5-flash → 2.5, claude-sonnet-4.5 → 4.5
 *   - hyphenated minor (Anthropic), e.g. claude-opus-4-1 → 4.1,
 *     claude-3-5-sonnet → 3.5, gpt-5-6 → 5.6 — two ADJACENT integer tokens are
 *     the major.minor (this is why bare-integer parsing collapsed Opus 4.8/4.7
 *     all to "4" and defeated curation)
 *   - fused with letters, e.g. o3 → 3, gpt-4o → 4, o4-mini → 4
 *   - bare major, e.g. gpt-5 → 5, glm-4 → 4
 * Parameter-size tokens (glm-4-32b → 4, not 4.32; gpt-oss-120b → 0) and trailing
 * dates are ignored.
 * @param {string} modelId
 * @returns {number} The version number, or 0 when none is present
 */
function extractVersion(modelId) {
  const tokens = modelId.toLowerCase()
    .replace(/^models\//, '')
    .replace(DATE_SUFFIX, '')
    .split('-')
    .filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    const token = /** @type {string} */ (tokens[i]);

    // Dotted major.minor carried in one token: "5.6", "4.1", "2.5".
    const dotted = token.match(/^\d+\.\d+/);
    if (dotted) return parseFloat(dotted[0]);

    // Pure-integer token: a following pure-integer token is the hyphenated
    // minor (claude-opus-4-1 → 4.1); otherwise it's a bare major (gpt-5 → 5).
    if (/^\d+$/.test(token)) {
      const next = tokens[i + 1];
      if (next && /^\d+$/.test(next)) return parseFloat(`${token}.${next}`);
      return parseFloat(token);
    }

    // Version fused with letters (o3 → 3, 4o → 4), but never a param size (32b).
    if (!PARAM_SIZE_TOKEN.test(token)) {
      const fused = token.match(/^[a-z]*(\d+)/) || token.match(/(\d+)[a-z]/);
      if (fused) return parseFloat(/** @type {string} */ (fused[1]));
    }
  }

  return 0;
}
