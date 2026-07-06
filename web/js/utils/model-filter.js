//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Model filtering utilities for identifying recommended models
 */

/**
 * Provider lists at or below this size are shown in full rather than filtered.
 * Set to twice TARGET_COUNT (the size of the recommended subset, 4): only once
 * a provider offers more than two subsets' worth of models is the curation
 * worth the hidden options.
 */
const FILTER_THRESHOLD = 8;

/**
 * Filter models to recommended subset (up to 4 models)
 * Strategy: Pick best from each category (pro codex, pro non-codex, budget codex, budget non-codex),
 * then fill remaining slots to reach 4 total by ranking all remaining candidates by quality
 * @param {Array<{id: string, displayName?: string}>} models - All models from provider
 * @returns {Array<{id: string, displayName?: string}>} Recommended models (up to 4 total)
 */
export function getRecommendedModels(models) {
  // Below the threshold (2× TARGET_COUNT) the list is short enough to show in
  // full — filtering down to the recommended subset isn't worth the noise.
  if (models.length <= FILTER_THRESHOLD) {
    return models;
  }

  // Filter out specialized/non-chat models
  const chatModels = models.filter(m => !isSpecializedModel(m.id));

  if (chatModels.length === 0) return models; // Fallback to all if filter too aggressive

  // Separate into pro and budget tiers
  const proModels = chatModels.filter(m => !isBudgetModel(m.id));
  const budgetModels = chatModels.filter(m => isBudgetModel(m.id));

  /** @type {Array<{id: string}>} */
  const recommended = [];

  // Pick best pro models (codex + non-codex)
  if (proModels.length > 0) {
    const codexPro = proModels.filter(m => isCodeSpecialized(m.id));
    const nonCodexPro = proModels.filter(m => !isCodeSpecialized(m.id));

    if (codexPro.length > 0) {
      recommended.push(selectBestFromCandidates(codexPro));
    }
    if (nonCodexPro.length > 0) {
      const bestNonCodex = selectBestFromCandidates(nonCodexPro);
      if (!recommended.find(m => m.id === bestNonCodex.id)) {
        recommended.push(bestNonCodex);
      }
    }
  }

  // Pick best budget models (codex + non-codex)
  if (budgetModels.length > 0) {
    const codexBudget = budgetModels.filter(m => isCodeSpecialized(m.id));
    const nonCodexBudget = budgetModels.filter(m => !isCodeSpecialized(m.id));

    if (codexBudget.length > 0) {
      const bestCodexBudget = selectBestFromCandidates(codexBudget);
      if (!recommended.find(m => m.id === bestCodexBudget.id)) {
        recommended.push(bestCodexBudget);
      }
    }
    if (nonCodexBudget.length > 0) {
      const bestNonCodexBudget = selectBestFromCandidates(nonCodexBudget);
      if (!recommended.find(m => m.id === bestNonCodexBudget.id)) {
        recommended.push(bestNonCodexBudget);
      }
    }
  }

  // Phase 2: Fill to 4 total if we have fewer and there are more candidates
  const TARGET_COUNT = 4;
  if (recommended.length < TARGET_COUNT && chatModels.length > TARGET_COUNT) {
    // Collect all candidates not already recommended
    const allCandidates = [...proModels, ...budgetModels];
    const remaining = allCandidates.filter(m =>
      !recommended.find(r => r.id === m.id)
    );

    if (remaining.length > 0) {
      // Rank by quality and add top N to reach target
      const rankedRemaining = rankByQuality(remaining);
      const needed = TARGET_COUNT - recommended.length;
      recommended.push(...rankedRemaining.slice(0, needed));
    }
  }

  // Fallback: if no models selected, return all
  return recommended.length > 0 ? recommended : models;
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
 * Check if model is code-specialized (codex variants)
 * These are PREFERRED for Juggler since it's a coding agent
 * @param {string} modelId
 * @returns {boolean} True if model is code-specialized
 */
function isCodeSpecialized(modelId) {
  return modelId.toLowerCase().includes('codex');
}

/**
 * Check if model is budget tier (mini/nano/lite/air/flash)
 * Note: "flash" models are faster/cheaper alternatives (e.g., gemini-flash vs gemini-pro)
 * @param {string} modelId
 * @returns {boolean} True if model is budget tier
 */
function isBudgetModel(modelId) {
  const budgetSuffixes = ['mini', 'nano', 'lite', 'air', 'flash'];
  const lower = modelId.toLowerCase();

  // Match as word components (with word boundaries), not arbitrary substrings
  // This prevents "gemini" from matching "mini"
  return budgetSuffixes.some(suffix => {
    const pattern = new RegExp(`(^|-)${suffix}($|-)`);
    return pattern.test(lower);
  });
}


/**
 * Rank all candidates by quality (for filling remaining recommendation slots)
 * Uses same ranking logic as selectBestFromCandidates but returns full sorted list
 * @param {Array<{id: string}>} candidates
 * @returns {Array<{id: string}>} Candidates sorted by quality (best first)
 */
function rankByQuality(candidates) {
  if (candidates.length === 0) return [];

  // 1. Separate models with "latest" suffix (highest priority)
  const latestModels = candidates.filter(m => m.id.includes('latest'));
  const nonLatestModels = candidates.filter(m => !m.id.includes('latest'));

  const latestRanked = latestModels.length > 0 ? selectByVersion(latestModels) : [];

  // 2. For non-latest, filter out preview/experimental (unless that's all we have)
  const stableModels = nonLatestModels.filter(m => !isPreviewModel(m.id));
  const candidatesForRanking = stableModels.length > 0 ? stableModels : nonLatestModels;

  // 3. Separate undated vs dated (prefer undated)
  const undatedModels = candidatesForRanking.filter(m => !hasDateSuffix(m.id));
  const datedModels = candidatesForRanking.filter(m => hasDateSuffix(m.id));

  const undatedRanked = undatedModels.length > 0 ? selectByVersion(undatedModels) : [];
  const datedRanked = datedModels.length > 0 ? selectByDate(datedModels) : [];

  // Combine: latest first, then undated, then dated
  return [...latestRanked, ...undatedRanked, ...datedRanked];
}

/**
 * Internal helper to select best from candidate list
 * @param {Array<{id: string}>} models
 * @returns {{id: string}} The best model from candidates
 */
function selectBestFromCandidates(models) {
  if (models.length === 1) return /** @type {{id: string}} */ (models[0]);

  // 1. Prefer models with "latest" suffix — pick the highest-versioned one
  const latestModels = models.filter(m => m.id.includes('latest'));
  if (latestModels.length > 0) {
    return /** @type {{id: string}} */ (selectByVersion(latestModels)[0]); // bounded: length > 0 checked above
  }

  // 2. Exclude preview/experimental unless that's all we have
  const stableModels = models.filter(m => !isPreviewModel(m.id));
  const candidates = stableModels.length > 0 ? stableModels : models;

  // 3. Prefer undated over dated
  const undatedModels = candidates.filter(m => !hasDateSuffix(m.id));
  if (undatedModels.length > 0) {
    return /** @type {{id: string}} */ (selectByVersion(undatedModels)[0]); // bounded: length > 0 checked above
  }

  // 4. All dated - pick latest date
  return /** @type {{id: string}} */ (selectByDate(candidates)[0]); // candidates non-empty (models non-empty)
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
 * Check if model has date suffix (YYYY-MM-DD)
 * @param {string} modelId
 * @returns {boolean} True if model has date suffix
 */
function hasDateSuffix(modelId) {
  return /\d{4}-\d{2}-\d{2}$/.test(modelId);
}

/**
 * Sort models by version number (highest first)
 * Handles: gpt-5.2 > gpt-5.1 > gpt-5, o4 > o3, gpt-4o > gpt-3.5, gemini-2.5 > gemini-2, glm-4.7 > glm-4.6
 * @param {Array<{id: string}>} models
 * @returns {Array<{id: string}>} Models sorted by version
 */
function selectByVersion(models) {
  return models.slice().sort((a, b) => {
    const versionA = extractVersion(a.id);
    const versionB = extractVersion(b.id);
    return versionB - versionA; // Higher version first
  });
}

/**
 * Extract version number from model ID
 * Examples: gpt-5.2 → 5.2, gemini-2.5-flash → 2.5, glm-4.7 → 4.7, o3-mini → 3, gpt-4o → 4
 * @param {string} modelId
 * @returns {number} The version number
 */
function extractVersion(modelId) {
  // Strip date suffixes first so they don't interfere (e.g., -2025-04-16)
  const withoutDate = modelId.replace(/-\d{4}-\d{2}-\d{2}$/, '');

  // 1. Try major.minor (e.g., gpt-5.2, gemini-2.5-flash, glm-4.7)
  const dotMatch = withoutDate.match(/(\d+\.\d+)/);
  if (dotMatch) {
    return parseFloat(/** @type {string} */ (dotMatch[1]));
  }

  // 2. Try integer version attached to a word or after hyphen (e.g., o3, gpt-4o, o4-mini)
  // Matches: letter+digits (o3, o4), or hyphen+digits (gpt-5, gpt-4)
  const intMatch = withoutDate.match(/[a-z](\d+)|(?:^|-)(\d+)(?:-|$)/);
  if (intMatch) {
    return parseFloat(/** @type {string} */ (intMatch[1] || intMatch[2]));
  }

  return 0;
}

/**
 * Sort models by date suffix (latest first)
 * @param {Array<{id: string}>} models
 * @returns {Array<{id: string}>} Models sorted by date
 */
function selectByDate(models) {
  return models.slice().sort((a, b) => {
    const dateA = extractDate(a.id);
    const dateB = extractDate(b.id);
    return dateB - dateA; // Latest date first
  });
}

/**
 * Extract date from model ID (YYYY-MM-DD or YYYY-MM)
 * @param {string} modelId
 * @returns {number} Timestamp in milliseconds
 */
function extractDate(modelId) {
  const match = modelId.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return new Date(`${match[1]}-${match[2]}-${match[3]}`).getTime();
  }

  // Try YYYY-MM format
  const monthMatch = modelId.match(/(\d{4})-(\d{2})/);
  if (monthMatch) {
    return new Date(`${monthMatch[1]}-${monthMatch[2]}-01`).getTime();
  }

  return 0;
}
