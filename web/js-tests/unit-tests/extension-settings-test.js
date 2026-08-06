//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { assert } from '../utilities/test-helpers.js';
import {
  decodeExtensionSettingValue,
  ExtensionSettingsEditor,
} from '../../js/components/settings/extensions-settings.js';

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label
   * @param {() => void|Promise<void>} fn - Test body
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (error) {
      failed++;
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await run('setting decoder validates typed values', () => {
    assert(decodeExtensionSettingValue({ key: 'n', type: 'number', label: 'Count' }, '2.5') === 2.5,
      'number was not decoded');
    assert(decodeExtensionSettingValue({ key: 'b', type: 'boolean', label: 'Enabled' }, true) === true,
      'boolean was not decoded');
    assert(decodeExtensionSettingValue({ key: 'e', type: 'enum', label: 'Mode', options: ['a', 'b'] }, 'b') === 'b',
      'enum was not decoded');
    assert(decodeExtensionSettingValue({ key: 'u', type: 'url', label: 'Host' }, '') === null,
      'blank optional URL should clear');
    let message = '';
    try {
      decodeExtensionSettingValue({ key: 'u', type: 'url', label: 'Host' }, 'not a url');
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    assert(message.includes('absolute URL'), 'invalid URL should have a useful error');
  });

  await run('editor renders all field types and loads effective values safely', async () => {
    const manifest = {
      id: '@test/settings', name: 'Settings', version: '1.0.0',
      settings: [
        { key: 'text', type: 'string', label: 'Text', help: 'Helpful', required: true },
        { key: 'token', type: 'secret', label: 'Token' },
        { key: 'enabled', type: 'boolean', label: 'Enabled', default: true },
        { key: 'count', type: 'number', label: 'Count' },
        { key: 'mode', type: 'enum', label: 'Mode', options: ['fast', 'safe'] },
        { key: 'host', type: 'url', label: 'Host' },
      ],
    };
    const editor = new ExtensionSettingsEditor(/** @type {any} */ (manifest), {
      get: async () => ({ text: 'hello', token: { __present: true }, enabled: true, count: 3, mode: 'safe' }),
      set: async () => ({}),
    });
    const root = editor.render();
    document.body.appendChild(root);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      assert(root.querySelectorAll('.extension-setting-field').length === 6, 'not every field rendered');
      assert(root.querySelector('input[type="text"]')?.value === 'hello', 'string value not loaded');
      assert(root.querySelector('input[type="checkbox"]')?.checked === true, 'boolean value not loaded');
      assert(root.querySelector('select')?.value === 'safe', 'enum value not loaded');
      const secret = /** @type {HTMLInputElement|null} */ (root.querySelector('input[type="password"]'));
      assert(secret?.value === '', 'secret value should never be rendered');
      assert(root.querySelector('.extension-secret-status')?.textContent === 'Set', 'secret presence not shown');
      assert(root.textContent?.includes('Helpful') && root.textContent?.includes('Default: true'),
        'help/default metadata not shown');
    } finally {
      root.remove();
    }
  });

  await run('editor saves typed values while preserving an unchanged secret', async () => {
    /** @type {any} */
    let request = null;
    const manifest = {
      id: '@test/settings', name: 'Settings', version: '1.0.0',
      settings: [
        { key: 'token', type: 'secret', label: 'Token' },
        { key: 'count', type: 'number', label: 'Count' },
        { key: 'enabled', type: 'boolean', label: 'Enabled' },
      ],
    };
    const effective = { token: { __present: true }, count: 1, enabled: false };
    const editor = new ExtensionSettingsEditor(/** @type {any} */ (manifest), {
      get: async () => effective,
      set: async (params) => { request = params; return { ...effective, ...params.values }; },
    });
    const root = editor.render();
    document.body.appendChild(root);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      /** @type {HTMLInputElement} */ (root.querySelector('input[type="number"]')).value = '7';
      /** @type {HTMLInputElement} */ (root.querySelector('input[type="checkbox"]')).checked = true;
      /** @type {HTMLButtonElement} */ (root.querySelector('.extension-settings-save')).click();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert(request?.extId === '@test/settings' && request.scope === 'global', 'wrong save envelope');
      assert(request.values.count === 7 && request.values.enabled === true, 'typed values not saved');
      assert(request.values.token?.__present === true, 'unchanged secret was not preserved');
      assert(root.querySelector('.extension-settings-message')?.textContent === 'Settings saved.',
        'success feedback missing');
    } finally {
      root.remove();
    }
  });

  await run('secret save and clear use isolated partial updates', async () => {
    /** @type {any[]} */
    const requests = [];
    const manifest = {
      id: '@test/settings', name: 'Settings', version: '1.0.0',
      settings: [{ key: 'token', type: 'secret', label: 'Token' }],
    };
    let present = false;
    const editor = new ExtensionSettingsEditor(/** @type {any} */ (manifest), {
      get: async () => ({ token: { __present: present } }),
      set: async (params) => {
        requests.push(params);
        present = params.values.token !== '';
        return { token: { __present: present } };
      },
    });
    const originalConfirm = window.showConfirm;
    window.showConfirm = async () => true;
    const root = editor.render();
    document.body.appendChild(root);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      const input = /** @type {HTMLInputElement} */ (root.querySelector('input[type="password"]'));
      input.value = 'new-secret';
      const buttons = root.querySelectorAll('.extension-secret-actions button');
      /** @type {HTMLButtonElement} */ (buttons[0]).click();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert(requests[0].values.token === 'new-secret', 'secret save did not send the new value');
      assert(input.value === '', 'secret input was not cleared after saving');
      /** @type {HTMLButtonElement} */ (buttons[1]).click();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert(requests[1].values.token === '', 'secret clear did not send an empty value');
      assert(root.querySelector('.extension-secret-status')?.textContent === 'Not set', 'clear status not shown');
    } finally {
      window.showConfirm = originalConfirm;
      root.remove();
    }
  });

  return { passed, failed, errors };
}
