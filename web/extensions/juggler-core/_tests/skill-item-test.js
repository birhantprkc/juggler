//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Skill context-item tests.
 *
 * Covers the two halves of the Agent Skills feature at the unit level, without a
 * backend:
 *  - The system-prompt "## Skills" block (`_buildBlock`): formatting, one-line
 *    description sanitisation + truncation, the 50-skill cap, and byte-stability
 *    (same skills in → identical text out, so it rides the prompt cache).
 *  - The freeze: seeding snapshots the catalog into `this.data.skills`, and the
 *    block/panel read that snapshot (not the live catalog) so an existing
 *    conversation's injected context never moves when skills change on disk.
 *  - The `skill` tool (`execute` + `getSummary`): a fresh load returns the
 *    SKILL.md body plus a resource listing (with SKILL.md itself elided); a
 *    repeat load in the same thread returns an "already loaded" notice; an
 *    unknown name is rejected. The skills service is stubbed via the item's
 *    `_listSkills` / `_loadBody` seams, so no server or on-disk skills required.
 * @module unit-tests/skill-item-test
 */

import SkillContextItem from '../context-items/skill-context-item.js';
import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../../../js-tests/utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * A SkillContextItem with the skills-service seams stubbed to fixture data, so
 * execute()/createContextText() run without a backend.
 */
class FakeSkillItem extends SkillContextItem {
  /**
   * @param {object} ctx - ContextItem constructor context
   * @param {any[]} skills - Fixture available-skills list
   * @param {Record<string, any>} bodies - name → {body, files} fixture details
   */
  constructor(ctx, skills, bodies) {
    super(ctx);
    this._skills = skills;
    this._bodies = bodies;
  }

  /** @returns {Promise<any[]>} Fixture skills */
  async _listSkills() {
    return this._skills;
  }

  /**
   * @param {string} _scope - Scope
   * @param {string} _source - Source
   * @param {string} name - Skill name
   * @returns {Promise<any>} Fixture detail
   */
  async _loadBody(_scope, _source, name) {
    if (!this._bodies[name]) {
      throw new Error(`no fixture body for ${name}`);
    }
    return this._bodies[name];
  }
}

/**
 * Run skill context-item tests.
 * @param {{fixtureDir: string}} _ctx - Test context (unused; no backend needed)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  await initializeRegistries();
  const session = await createTestSession();
  const conversation = await createTestConversation(session);

  /**
   * @param {any[]} skills - Fixture skills
   * @param {Record<string, any>} [bodies] - Fixture bodies
   * @returns {FakeSkillItem} Item bound to the test conversation
   */
  function makeItem(skills, bodies = {}) {
    return new FakeSkillItem(
      { id: `SKILL_${Math.random().toString(36).slice(2)}`, session, conversation, messageThread: conversation.rootMessageThread },
      skills,
      bodies
    );
  }

  // ---- system-prompt block (_buildBlock) ---------------------------------

  await test('empty skills contribute nothing', () => {
    assert(SkillContextItem._buildBlock([]) === '', 'empty list must yield empty string');
    assert(SkillContextItem._buildBlock(/** @type {any} */ (null)) === '', 'null must yield empty string');
  });

  await test('block lists one name: description line per skill, under a ## Skills heading', () => {
    const block = SkillContextItem._buildBlock([
      { name: 'a-skill', description: 'first' },
      { name: 'b-skill', description: 'second' }
    ]);
    assert(block.startsWith('## Skills'), `should start with heading; got:\n${block}`);
    const lines = block.split('\n');
    assert(lines.includes('- a-skill: first'), `missing a-skill line; got:\n${block}`);
    assert(lines.includes('- b-skill: second'), `missing b-skill line; got:\n${block}`);
  });

  await test('block is byte-stable for identical input (cache-friendly)', () => {
    const skills = [{ name: 'a', description: 'x' }, { name: 'b', description: 'y' }];
    const a = SkillContextItem._buildBlock(skills);
    const b = SkillContextItem._buildBlock(skills);
    assert(a === b, 'same skills must produce byte-identical block');
  });

  await test('descriptions are collapsed to a single line', () => {
    const block = SkillContextItem._buildBlock([
      { name: 'x', description: 'line one\n\nline two   with   spaces' }
    ]);
    const lines = block.split('\n');
    assert(lines.includes('- x: line one line two with spaces'), `newlines/space not collapsed; got:\n${block}`);
  });

  await test('long descriptions are truncated with an ellipsis', () => {
    const block = SkillContextItem._buildBlock([{ name: 'z', description: 'q'.repeat(500) }]);
    const zline = block.split('\n').find((l) => l.startsWith('- z:')) || '';
    assert(zline.length < 250, `description not truncated; line length ${zline.length}`);
    assert(zline.endsWith('…'), 'truncated line should end with an ellipsis');
  });

  await test('descriptions are capped at 50 skills; overflow is listed by name so it stays activatable', () => {
    const many = Array.from({ length: 60 }, (_v, i) => ({ name: `s${String(i).padStart(2, '0')}`, description: 'd' }));
    const block = SkillContextItem._buildBlock(many);
    const shown = block.split('\n').filter((l) => /^- s\d\d:/.test(l));
    assert(shown.length === 50, `should show exactly 50 described skills, showed ${shown.length}`);
    assert(block.includes('…and 10 more, loadable by exact name:'), `missing overflow note; got tail:\n${block.split('\n').slice(-2).join('\n')}`);
    assert(block.includes('s50') && block.includes('s59'), 'every overflow skill name must still be listed');
  });

  await test('createContextText renders the block from the available skills', async () => {
    const item = makeItem([{ name: 'pdf-tools', description: 'Handle PDFs' }]);
    const block = await item.createContextText({});
    assert(block.startsWith('## Skills'), 'context text should be the skills block');
    assert(block.includes('- pdf-tools: Handle PDFs'), `missing skill line; got:\n${block}`);
  });

  // ---- the skill tool (execute + getSummary) -----------------------------

  const oneSkill = [{ name: 'pdf-tools', description: 'Handle PDFs', scope: 'project', source: 'juggler' }];
  const oneBody = {
    'pdf-tools': {
      body: '# PDF tools\n\nStep one.',
      files: [
        { path: 'SKILL.md', size: 40 },
        { path: 'references/api.md', size: 1200 },
        { path: 'scripts/run.sh', size: 7 }
      ]
    }
  };

  await test('validate requires a non-empty name and trims it', async () => {
    const item = makeItem(oneSkill, oneBody);
    const bad = await item.validate({});
    assert(bad.valid === false, 'missing name must be invalid');
    const ok = await item.validate({ name: '  pdf-tools  ' });
    assert(ok.valid === true && ok.params.name === 'pdf-tools', 'valid name must be trimmed');
  });

  await test('loading a skill returns its body and a resource listing (SKILL.md elided)', async () => {
    const item = makeItem(oneSkill, oneBody);
    const res = await item.execute({ name: 'pdf-tools' });
    assert(res.alreadyLoaded === false, 'first load should not be already-loaded');
    const summary = item.getSummary({ success: true, result: res }).summary;
    assert(summary.includes('Skill: pdf-tools (project/juggler)'), `missing origin header; got:\n${summary}`);
    assert(summary.includes('# PDF tools'), 'body must be present in the tool result');
    assert(summary.includes('references/api.md'), 'resource file should be listed');
    assert(summary.includes('scripts/run.sh'), 'script file should be listed');
    assert(!summary.includes('SKILL.md'), 'SKILL.md itself must not be listed as a resource');
  });

  await test('re-loading the same skill in a thread returns an already-loaded notice', async () => {
    const item = makeItem(oneSkill, oneBody);
    await item.execute({ name: 'pdf-tools' });
    const res2 = await item.execute({ name: 'pdf-tools' });
    assert(res2.alreadyLoaded === true, 'second load should be flagged already-loaded');
    const summary = item.getSummary({ success: true, result: res2 }).summary;
    assert(summary.includes('already loaded'), `expected already-loaded notice; got:\n${summary}`);
    assert(!summary.includes('# PDF tools'), 'already-loaded notice must not re-inject the body');
  });

  await test('an unknown skill name is rejected', async () => {
    const item = makeItem(oneSkill, oneBody);
    let threw = false;
    try {
      await item.execute({ name: 'does-not-exist' });
    } catch (/** @type {any} */ e) {
      threw = true;
      assert(/No skill named/.test(e.message), `unexpected error message: ${e.message}`);
    }
    assert(threw, 'loading an unknown skill must throw');
  });

  await test('getSummary reports a failed load', () => {
    const item = makeItem(oneSkill, oneBody);
    const summary = item.getSummary({ success: false, error: 'boom' });
    assert(summary.success === false, 'failed outcome must be success:false');
    assert(summary.summary.includes('boom'), 'error message must surface');
  });

  // ---- auto-instantiate / seeding path -----------------------------------

  await test('properties panel lists the available skills, not just the type name', async () => {
    const item = makeItem(oneSkill, oneBody);
    const container = document.createElement('div');
    await item._renderPanel(container);
    const text = container.textContent || '';
    assert(text !== 'skill', 'panel must not be just the bare type name');
    assert(text.includes('pdf-tools'), `panel should list the skill name; got:\n${text}`);
    assert(text.includes('Handle PDFs'), `panel should show the skill description; got:\n${text}`);
    assert(/in the system prompt/i.test(text), 'panel should explain the skills are listed in the system prompt');
  });

  await test('properties panel marks a skill loaded once activated in this thread', async () => {
    const item = makeItem(oneSkill, oneBody);
    await item.execute({ name: 'pdf-tools' });
    const container = document.createElement('div');
    await item._renderPanel(container);
    assert(/loaded/i.test(container.textContent || ''), 'an activated skill should be marked loaded in the panel');
  });

  await test('properties panel shows an empty state when no skills exist', async () => {
    const item = makeItem([]);
    const container = document.createElement('div');
    await item._renderPanel(container);
    assert(/No skills available/i.test(container.textContent || ''), 'empty catalog should show an empty-state note');
  });

  await test('seeding via handleToolCall with empty params succeeds (no base onToolCall throw)', async () => {
    // When ≥1 skill exists the item auto-instantiates and is seeded through
    // executeContextItem -> handleToolCall('skill', {}). Without a no-op
    // onToolCall override this hit the base class throw
    // ("onToolCall() must be implemented by subclass") and injected that error
    // as a context-item message. Guard the no-op override stays in place.
    const item = makeItem(oneSkill, oneBody);
    const ctx = { session, conversation };
    const result = await item.handleToolCall('skill', {}, ctx);
    assert(result.success === true, `seed must succeed; got error: ${result.error}`);
    assert(
      !/must be implemented by subclass/.test(result.error || ''),
      'seed must not surface the base-class onToolCall error'
    );
  });

  await test('seeding freezes the available-skills snapshot into the doc (this.data.skills)', async () => {
    const item = makeItem(oneSkill, oneBody);
    await item.handleToolCall('skill', {}, { session, conversation });
    assert(Array.isArray(item.data.skills), 'seed should freeze a skills snapshot into this.data.skills');
    assert(
      item.data.skills.length === 1 && item.data.skills[0].name === 'pdf-tools',
      `snapshot should record the available skills; got: ${JSON.stringify(item.data.skills)}`
    );
    assert(item.data.skills[0].scope === 'project' && item.data.skills[0].source === 'juggler',
      'snapshot must carry scope/source so the skill tool can resolve a load');
  });

  await test('the FROZEN snapshot, not the live catalog, drives the block and panel', async () => {
    const item = makeItem([{ name: 'a-skill', description: 'first' }], {});
    await item.handleToolCall('skill', {}, { session, conversation });
    // Mutate the live catalog AFTER seeding — a frozen conversation must not move.
    item._skills = [{ name: 'b-skill', description: 'second' }];
    const block = await item.createContextText({});
    assert(block.includes('- a-skill: first'), `block should reflect the frozen snapshot; got:\n${block}`);
    assert(!block.includes('b-skill'), 'block must not reflect post-seed catalog changes');
    const container = document.createElement('div');
    await item._renderPanel(container);
    const text = container.textContent || '';
    assert(text.includes('a-skill') && !text.includes('b-skill'),
      `panel must show the frozen snapshot, not the live catalog; got:\n${text}`);
  });

  await test('the freeze is write-once: re-seeding keeps the original snapshot', async () => {
    const item = makeItem([{ name: 'a-skill', description: 'first' }], {});
    await item.handleToolCall('skill', {}, { session, conversation });
    item._skills = [{ name: 'b-skill', description: 'second' }];
    await item.handleToolCall('skill', {}, { session, conversation });
    assert(
      item.data.skills.length === 1 && item.data.skills[0].name === 'a-skill',
      `re-seed must not overwrite the frozen snapshot; got: ${JSON.stringify(item.data.skills)}`
    );
  });

  await test('createContextText falls back to a live scan when not seeded (no frozen snapshot)', async () => {
    const item = makeItem([{ name: 'live-skill', description: 'unfrozen' }]);
    const block = await item.createContextText({});
    assert(block.includes('- live-skill: unfrozen'),
      `unseeded item should fall back to the live list; got:\n${block}`);
  });

  return { passed, failed, errors };
}
