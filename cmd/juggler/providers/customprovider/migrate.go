//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package customprovider

import (
	"encoding/json"
	"os"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/internal/jlog"
)

// LegacyID is the id of the endpoint that was once Juggler's only custom
// OpenAI-compatible provider, configured through three raw credentials rather
// than through an instance record.
//
// It is the one instance whose registered provider id is not prefixed, and the
// one whose credential key and environment variable keep their historic names.
// The id is what every stored reference names — default-model.json,
// cheap-model.json, recent-models.json, models.hidden, models.limits and every
// conversation document — and there is no transaction spanning those, so it can
// never be renamed.
const LegacyID = "openai-compatible"

// The raw credentials the single endpoint was configured through. The API key
// is left where it is: the migrated instance registers a ConfigKeyName naming
// this same key, so the user's existing key is found unmoved.
const (
	legacyBaseURLCredKey = "openai_compatible_base_url"
	legacyHeadersCredKey = "openai_compatible_headers"
	legacyAPIKeyCredKey  = "openai_compatible_api_key"
	legacyEnvVarName     = "OPENAI_COMPATIBLE_API_KEY"
	legacyDisplayName    = "OpenAI-compatible (custom)"
)

// migrateLegacySingleton turns the one endpoint the raw credentials describe
// into instance #1, so a user who configured it before there could be several
// finds it still there, still selected, still holding its key.
//
// The file's existence is the whole record of having run: the credentials it
// reads are never cleared (a downgrade would need them), so a user who deletes
// the migrated endpoint would otherwise have it resurrected on every start.
func migrateLegacySingleton() error {
	if _, err := os.Stat(configPath()); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}

	store, err := core.NewCredentialsStore()
	if err != nil {
		return err
	}
	baseURL := strings.TrimSpace(store.GetRawKey(legacyBaseURLCredKey))
	if baseURL == "" {
		// Nothing was ever configured. Writing a file here would be a lie about
		// having asked, and would suppress the migration for a user who
		// configures the old provider on an older build later.
		return nil
	}

	instance := Instance{
		DisplayName: legacyDisplayName,
		Protocol:    ProtocolOpenAI,
		BaseURL:     baseURL,
		Headers:     parseHeaderJSON(store.GetRawKey(legacyHeadersCredKey)),
	}
	if err := ValidateInstance(instance); err != nil {
		// A URL that predates validation is not worth refusing to start over.
		// Nothing is written, so the endpoint is simply absent until the user
		// re-enters it — and the reason is in the log.
		jlog.Error("[CustomProvider] Not migrating the existing OpenAI-compatible endpoint: %v", err)
		return nil
	}
	return Save(map[string]Instance{LegacyID: instance})
}

// parseHeaderJSON parses a JSON object of string→string header pairs. Blank
// input returns nil; malformed input is logged and treated as no headers, so a
// typo in the old settings box costs the headers rather than the endpoint.
func parseHeaderJSON(raw string) map[string]string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var parsed map[string]string
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		jlog.Error("[CustomProvider] Ignoring invalid custom headers JSON: %v", err)
		return nil
	}
	if len(parsed) == 0 {
		return nil
	}
	return parsed
}
