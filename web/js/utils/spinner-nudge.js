//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Kick rendered `<juggler-spinner>`s under `root` so a frozen one repaints.
 * WebKit doesn't reliably repaint a spinner whose animation was paused (via
 * `data-doc-hidden`) while the window was backgrounded; toggling display forces
 * the same reflow a tab switch would. `getClientRects` skips off-layout spinners.
 * @param {ParentNode} [root=document]
 */
export function nudgeSpinners(root = document) {
  root.querySelectorAll('juggler-spinner').forEach((el) => {
    const spinner = /** @type {HTMLElement} */ (el);
    if (spinner.getClientRects().length === 0) return;
    const prev = spinner.style.display;
    spinner.style.display = 'none';
    void spinner.offsetHeight; // force reflow
    spinner.style.display = prev;
  });
}
