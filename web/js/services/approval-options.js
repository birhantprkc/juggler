//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Approval button construction — the single framework rule for turning a
 * plugin's auto-approval suggestions into approval-dialog buttons.
 *
 * The plugin is the SOLE source of "don't ask again" buttons. The framework
 * never invents one: it renders an affirmative button, one "don't ask again"
 * button per suggestion the plugin returns from `getApprovalSuggestions`
 * (escalating breadth, narrowest first), and a decline button. A plugin that
 * offers no meaningful pattern returns `[]` and the user simply sees Yes / No —
 * a bare "don't ask again" with nothing to remember is never shown.
 *
 * Each "don't ask again" button carries the exact `rules`/`itemType` it will
 * persist and displays the suggestion's `label` as its pattern, so the button
 * always tells the user precisely what it will remember.
 * @module services/approval-options
 */

/**
 * Build the approval button list for an action that requires approval.
 * @param {{getApprovalSuggestions?: (params: Record<string, unknown>) => import('juggler/context-item').ApprovalSuggestion[]}} action - Action instance
 * @param {Record<string, unknown>} [params] - Validated tool input the suggestions are derived from
 * @returns {import('../components/action-confirmation.js').ApprovalOption[]} Buttons: Yes, one per suggestion, No
 */
export function buildApprovalButtons(action, params = {}) {
  /** @type {import('juggler/context-item').ApprovalSuggestion[]} */
  const suggestions = action.getApprovalSuggestions?.(params) || [];

  /** @type {import('../components/action-confirmation.js').ApprovalOption[]} */
  const options = [{ label: 'Yes', value: 'yes', style: 'primary' }];

  suggestions.forEach((s, i) => {
    options.push({
      label: 'Yes + Don\'t Ask Again',
      value: `yes-always:${i}`,
      style: 'primary-always',
      pattern: s.label,
      patterns: s.patterns,
      rules: s.rules,
      allowedPaths: s.allowedPaths,
      itemType: s.itemType
    });
  });

  options.push({ label: 'No', value: 'no', style: 'secondary' });
  return options;
}
