# Licensing

This repository contains code under two licenses. The split exists so that the
extension API is maximally permissive — you can build anything on it, including
closed-source extensions — while the application itself remains strong copyleft.

## The map

| Path | License | What it is |
|---|---|---|
| `web/sdk/**` | [Apache-2.0](web/sdk/LICENSE) | The extension SDK: the `juggler/*` modules extensions import, plus the self-contained support library in `web/sdk/lib/`. |
| `web/extensions/**` | [Apache-2.0](web/extensions/LICENSE) | Bundled extensions, including `juggler-core` — the reference implementation of Juggler's built-in tools, and the best starting point for writing your own. |
| Everything else | [AGPL-3.0-or-later](LICENSE) | The application: Go server and desktop app, web UI, build tooling, tests, docs. |

Every source file carries an SPDX identifier and a license line in its header;
the per-directory `LICENSE` files above are authoritative for their trees.

## What this means for extension authors

Extension code imports the SDK through the `juggler/*` module specifiers (see
`docs/extension_guide.md`). Those modules — and everything under `web/sdk/lib/`
— are Apache-2.0, so an extension built against them incurs **no copyleft
obligation**: you may license your own extension however you like, closed
source included. Forking files from `web/extensions/juggler-core/` as a
starting point is equally unencumbered.

The AGPL applies to the application that *hosts* your extension, not to your
extension. Running your extension inside Juggler is use of the app, which the
AGPL does not restrict; distributing your extension distributes none of
Juggler's AGPL code.

## Boundary audit

The SDK/app dependency boundary was audited (2026-07) and is enforced as
follows:

- **Self-contained**: `web/sdk/lib/**` imports nothing outside `web/sdk`.
  The SDK entry modules `context-item.js`, `command-type.js`, `item-utils.js`,
  `item-utils-worker.js`, `ui-worker.js`, `sandbox.js`, `coerce-schema-types.js`
  and `version.js` are likewise fully self-contained.
- **Declared host bindings**: the SDK is the *interface* to a running Juggler
  host, and a small number of facade re-exports intentionally bind to the
  host's AGPL implementation. As shipped in this repository these are:
  - `sdk/registry.js` → `js/registries/context-item-registry.js`
  - `sdk/ui.js` → `js/utils/popup-surface.js`,
    `js/utils/properties-panel-helpers.js`, `js/components/project-picker.js`
  - `sdk/ops.js` → `js/services/ops-api.js`, `js/services/fs.js`
  - `sdk/strategy-type.js` → `js/services/thread-orchestrator.js`,
    `js/services/tool-generator.js`
  - `sdk/model.js` → `js/utils/compaction-utils.js`
  - `extensions/juggler-core/context-items/system-prompt-context-item.js` →
    `js/services/system-prompt-presets.js`, `js/services/extensions.js`

  These bindings mean the SDK facade, as shipped, resolves those symbols
  against this application. A third party reimplementing a host would provide
  their own implementations behind the same Apache-licensed interface.
  Extension authors are unaffected — the modules *they* import are Apache-2.0.
- **Type-only references**: JSDoc `@type {import('../js/…')}` annotations in
  Apache files reference host types for type-checking. They are comments,
  create no runtime dependency, and are erased by any bundler.

The reverse direction — the AGPL app importing from the Apache SDK — is
unrestricted and common (the app uses its own SDK).

## Official binaries and the pro tier

Official Juggler binaries are built and distributed from a separate private
repository. They may bundle additional proprietary components (paid features)
alongside the open code in this repository. The licenses above apply to this
repository's contents wherever they appear; proprietary add-ons are separate
works layered on the extension seams, not modifications of the AGPL code.

If you want to use Juggler's AGPL code in a way the AGPL doesn't permit,
contact the author about commercial licensing.

## Contributions

All contributions require a `Signed-off-by:` line certifying the
[Developer Certificate of Origin](DCO) — see
[CONTRIBUTING.md](CONTRIBUTING.md#sign-your-work). A contribution is licensed
under the license of the directory it lands in (Apache-2.0 for `web/sdk/**`
and `web/extensions/**`, AGPL-3.0-or-later elsewhere).
