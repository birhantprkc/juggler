//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package zai

import "juggler/cmd/juggler/providers/utils"

// The model *list* is never hardcoded — ListModelsWithInfo pulls it live from
// z.ai's /models endpoint, so new GLM releases appear automatically. What lives
// here is the per-model capability metadata that endpoint does NOT return: its
// objects carry only id/object/created/owned_by, no context window or output
// cap. So these are local fallbacks keyed by model id, with defaults tuned to
// the current catalog. TestModelMetadataCoversCatalog_Live flags drift when the
// API starts advertising a model the defaults would mis-size.

// ModelContextWindows overrides DefaultContextWindow for models whose window is
// not 200K. The bulk of the modern line (glm-4.6 onward, glm-5, glm-5.1) is 200K;
// the glm-4.5 series is 128K. GLM-5.2 carries a 1M-token window under its plain
// base id — z.ai serves it directly over the standard coding endpoint, not via a
// special variant. (Verified on the wire: the coding endpoint ingested and billed
// 640K+ input tokens for a single glm-5.2 request. An earlier "glm-5.2[1m]" suffix
// was a phantom — z.ai 400s it as "Unknown Model" — so the 1M window belongs on
// the base id, not an opt-in variant.)
var ModelContextWindows = map[string]int{
	"glm-4.5":     128000,
	"glm-4.5-air": 128000,
	"glm-5.2":     1000000,
}

// DefaultContextWindow is used for unknown models. The whole current z.ai
// catalog is 200K except the glm-4.5 series above, so a new model is far more
// likely 200K than not — the optimistic default matches reality.
const DefaultContextWindow = 200000

// DefaultMaxOutputTokens is the per-request output cap. GLM is a reasoning
// model — it spends output budget thinking before answering — so this sits well
// above a non-reasoning default to give chain-of-thought room to complete; an
// 8192 cap throttled the reasoning itself, producing empty `finish=length`
// turns. Every model in the current catalog accepts 65536, which also stays
// under z.ai's coding-plan output ceiling (~98K), so no per-model override is
// needed and a newly-released model inherits the right cap automatically.
const DefaultMaxOutputTokens = 65536

// contextWindowCaps / maxOutputCaps are the single source for per-model
// lookups, consumed by both the Get* getters and the provider Descriptor.
var (
	contextWindowCaps = utils.ModelCaps{Default: DefaultContextWindow, Overrides: ModelContextWindows}
	maxOutputCaps     = utils.ModelCaps{Default: DefaultMaxOutputTokens}
)
