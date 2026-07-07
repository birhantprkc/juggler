//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/osactivity"
	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/server/handlers"
	"juggler/cmd/juggler/worker"
	"juggler/internal/jlog"
	"juggler/internal/userpaths"
	"juggler/web"
)

// createExtensionsAPI constructs the unified manifest-driven ExtensionsAPI, the
// single owner of extension discovery and the on-disk locations they live in.
func createExtensionsAPI(s *Server, projectPath string, devMode bool) *handlers.ExtensionsAPI {
	var builtinFS fs.FS
	builtinDir := "" // disk path of web/ in dev mode, so builtin extensions expose revealable files
	if devMode {
		if webDir := findWebDir(); webDir != "" {
			builtinFS = os.DirFS(webDir)
			builtinDir = webDir
			jlog.Info("📂 Dev mode: Loading builtin assets from disk: %s", webDir)
		} else {
			jlog.Error("Dev mode: Could not find web/ directory, using embedded files")
			builtinFS, _ = fs.Sub(web.Files, ".")
		}
	} else {
		builtinFS, _ = fs.Sub(web.Files, ".")
	}

	userExtensionDir := filepath.Join(userpaths.ConfigDir(), "extensions")
	return handlers.NewExtensionsAPI(builtinFS, builtinDir, userExtensionDir)
}

// generateStaticVersion produces a random 4-char base36 string for cache-busting asset URLs.
func generateStaticVersion() string {
	versionBytes := make([]byte, 3)
	_, _ = rand.Read(versionBytes)
	n := new(big.Int).SetBytes(versionBytes)
	n.Mod(n, big.NewInt(36*36*36*36))
	v := n.Text(36)
	for len(v) < 4 {
		v = "0" + v
	}
	return v
}

// seedProjectState initialises the atomic projectState from the boot configuration.
func (s *Server) seedProjectState(cfg Config) {
	initialProjectPath := cfg.ProjectPath
	if smPath := cfg.SessionManager.GetProjectPath(); smPath != "" {
		initialProjectPath = smPath
	}
	s.projectState.Store(&projectState{
		projectPath:    initialProjectPath,
		sessionManager: cfg.SessionManager,
		lock:           cfg.BootLock,
		viewers:        newViewerGroup(),
	})
}

// wireWorkerManager connects the worker manager to the server's LLM caller, cancel hook,
// and path/persistence callbacks.
func (s *Server) wireWorkerManager() {
	s.workerManager.SetLLMCaller(s.createLLMCaller())

	// Engine-readiness gate for worker-driven strategy hooks: the worker waits
	// for the hidden engine to be connected before dispatching onActivate at
	// turn-start. Same gate the LLM caller uses; nil in tests / the test-pool,
	// where the engine is always-on.
	s.workerManager.SetEngineReadyFunc(s.ensureEngineReady)

	// Outbound-sync coalescing window. Production uses the default
	// (SyncThrottleMs); the integration test harness sets
	// JUGGLER_TEST_SYNC_THROTTLE_MS to widen it so a fast turn's busy→idle
	// window always merges into one broadcast — a knob for surfacing waits that
	// depend on a transient state edge rather than the durable turn fence. Read
	// here at wiring time (not in the worker constructor) and injected via the
	// manager.
	if v := os.Getenv("JUGGLER_TEST_SYNC_THROTTLE_MS"); v != "" {
		if ms, err := strconv.Atoi(v); err == nil && ms > 0 {
			s.workerManager.SetSyncThrottle(time.Duration(ms) * time.Millisecond)
		}
	}

	// Provider-side cancel: routes through the Conversation cache, which holds
	// the open handle and calls handle.Cancel() directly. Cancel is always
	// warm-preserving — it releases live subprocess state but keeps the
	// resume token / prompt-cache anchor — so the next turn resumes warm.
	s.workerManager.SetCancelLLMSession(s.conversationCache.CancelConversation)

	// Autonomous-turn routing: a turn the provider emits with no Submit in
	// flight (a scheduled wake / monitor firing through a persistent CLI)
	// surfaces via the handle's TurnSink. Route each such turn to the owning
	// worker as a `provider-turn` inbound message, where it lands in Yjs
	// ordered against user sends by the worker's inbound FIFO. The cache
	// Subscribe()s every newly-opened handle to this factory's sink.
	s.conversationCache.SetTurnSinkFactory(func(convID string) provider.TurnSink {
		return &workerTurnSink{convID: convID, manager: s.workerManager}
	})

	// Path resolution and binary persistence routed through the actor to keep
	// rename ↔ save serialisation correct across project switches.
	s.workerManager.SetPathProvider(func(convID string) (string, bool) {
		sm := s.SessionManager()
		if sm == nil {
			return "", false
		}
		return sm.ConvDir(convID)
	})
	s.workerManager.SetSaveBinary(func(convID string, data []byte) error {
		sm := s.SessionManager()
		if sm == nil {
			return fmt.Errorf("no session manager available")
		}
		// Owned-only save: the worker manager is server-lifetime, so a worker
		// created under a previous project can still fire a debounced save after
		// a SwitchProject swapped in this SessionManager. Late-binding to the
		// current project here (sm is resolved per call) means such a save would
		// otherwise fabricate an "Untitled--<id>" ghost folder in the wrong
		// project — the cross-project conversation leak. Refuse ids this project
		// doesn't own; the owning project persists them when it is loaded.
		saved, err := sm.SaveConversationBinaryIfOwned(convID, data)
		if err != nil {
			return err
		}
		if !saved {
			jlog.Debug("[worker.save] skipped unowned conv=%s (not in loaded project)", convID)
		}
		return nil
	})
}

// createLLMCaller creates a function that workers can use to call the
// LLM directly. The closure captures the per-server conversationCache so
// Conversation handles are reused across turns for the same (convID,
// provider, model) triple. The cache also owns shutdown semantics: conv
// delete → cc.CloseConversation(convID); server shutdown → cc.Shutdown.
func (s *Server) createLLMCaller() worker.LLMCallFunc {
	return func(ctx context.Context, request json.RawMessage, chunkHandler func(worker.StreamChunk)) (*worker.LLMResponse, error) {
		// Wait for the hidden engine WebView to be connected before the turn
		// starts, so it is ready before the provider streams any tool_use. Fails
		// the turn with a clear error rather than letting tool requests be
		// silently dropped to a missing engine. No-op (returns true) in tests and
		// the test-pool, where the engine is an always-on iframe.
		if !s.ensureEngineReady() {
			return nil, fmt.Errorf("engine is not available — tools cannot execute (the engine WebView did not connect in time)")
		}

		// Parse worker request
		var req struct {
			SystemPrompt   string               `json:"systemPrompt"`
			Messages       []provider.Message   `json:"messages"`
			Tools          []ToolDefinition     `json:"tools"`
			ConversationID string               `json:"conversationId"`
			ThreadID       string               `json:"threadId"`
			ModelConfig    ModelConfig          `json:"modelConfig"`
			TransactionID  string               `json:"transactionId"`
			ToolChoice     *provider.ToolChoice `json:"toolChoice,omitempty"`
		}
		if err := json.Unmarshal(request, &req); err != nil {
			return nil, fmt.Errorf("failed to parse LLM request: %w", err)
		}

		// Resolve image attachments: the worker→caller JSON carries only an
		// asset reference (AssetID + mime + dims), never the bytes. Load the
		// bytes from the per-conversation asset store here, in memory, just
		// before Submit, so raw image data never travels in the request JSON and
		// is never marshaled by the cost estimator. A missing asset is logged
		// and skipped (the part is dropped at transform time) rather than
		// failing the whole turn.
		assetStore := worker.NewAssetStore(func(convID string) (string, bool) {
			sm := s.SessionManager()
			if sm == nil {
				return "", false
			}
			return sm.ConvDir(convID)
		})
		for i := range req.Messages {
			for j := range req.Messages[i].Parts {
				part := &req.Messages[i].Parts[j]
				if part.AssetID == "" || len(part.Data) > 0 {
					continue
				}
				data, mime, err := assetStore.Get(req.ConversationID, part.AssetID)
				if err != nil {
					jlog.Error("LLM caller: could not resolve asset %s for conversation %s: %v", part.AssetID, req.ConversationID, err)
					continue
				}
				part.Data = data
				if part.Mime == "" {
					part.Mime = mime
				}
			}
		}

		// Get credentials
		creds, err := core.NewCredentialsStore()
		if err != nil {
			return nil, fmt.Errorf("failed to get credentials: %w", err)
		}
		credential, err := creds.GetProviderCredential(req.ModelConfig.Provider)
		if err != nil {
			return nil, fmt.Errorf("failed to get credentials: %w", err)
		}

		// Open (or reuse) the per-conversation handle. The cache binds
		// state to (convID, providerName, model); a mid-conversation
		// model switch closes the old handle and opens a fresh one. The
		// turn's ThreadID rides on the MessageRequest below — a stateful
		// provider (claudecode) keys its per-thread session off it.
		conv, err := s.conversationCache.GetOrOpen(ctx, req.ConversationID, req.ModelConfig.Provider, req.ModelConfig.Model, credential)
		if err != nil {
			return nil, fmt.Errorf("open conversation: %w", err)
		}

		// Convert tools
		providerTools := make([]provider.ToolDefinition, len(req.Tools))
		for i, tool := range req.Tools {
			providerTools[i] = provider.ToolDefinition{
				Name:        tool.Name,
				Description: tool.Description,
				InputSchema: tool.InputSchema,
			}
		}

		mreq := provider.MessageRequest{
			Messages:       req.Messages,
			SystemPrompt:   req.SystemPrompt,
			Tools:          providerTools,
			ConversationID: req.ConversationID,
			ThreadID:       req.ThreadID,
			ToolChoice:     req.ToolChoice,
		}

		// Adapter that bridges Provider's StructuredStreamCallback to the
		// worker's chunk-handler shape and accumulates structured blocks
		// so the worker can post-process tool_use blocks once the turn
		// completes (text/thinking are visible mid-stream via chunks).
		var blocks []provider.ContentBlock
		cb := func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			// Status chunks are transient (rate-limit retries, parking
			// notes). Surface to worker as a chunk; don't accumulate.
			if chunk.Type == provider.ContentBlockTypeStatus {
				chunkHandler(worker.StreamChunk{Type: chunk.Type, Content: chunk.Content})
				return nil, nil
			}
			// Progress chunks carry a running output-token estimate for the
			// UI's mid-stream spinner. Transient — never accumulated.
			if chunk.Type == provider.ContentBlockTypeProgress {
				out, _ := chunk.Metadata["outputTokens"].(int)
				chunkHandler(worker.StreamChunk{Type: chunk.Type, OutputTokens: out})
				return nil, nil
			}
			// Usage chunks carry the mid-stream input-token anchor (and any
			// cache hit/TTL the provider has reported so far). Transient —
			// never accumulated; the end-of-turn write overwrites with
			// final numbers.
			if chunk.Type == provider.ContentBlockTypeUsage {
				in, _ := chunk.Metadata["inputTokens"].(int)
				cached, _ := chunk.Metadata["cachedTokens"].(int)
				var ttlMs int64
				switch v := chunk.Metadata["cacheTTLMs"].(type) {
				case int64:
					ttlMs = v
				case int:
					ttlMs = int64(v)
				}
				chunkHandler(worker.StreamChunk{
					Type:         chunk.Type,
					InputTokens:  in,
					CachedTokens: cached,
					CacheTTLMs:   ttlMs,
				})
				return nil, nil
			}
			chunkHandler(worker.StreamChunk{Type: chunk.Type, Content: chunk.Content})
			// Coalesce adjacent text/thinking deltas into a single block so the
			// transaction JSON records one block per logical content block, not
			// one per streamed delta. Tool_use and other discrete chunks always
			// start a fresh block.
			if n := len(blocks); n > 0 &&
				(chunk.Type == provider.ContentBlockTypeText || chunk.Type == provider.ContentBlockTypeThinking) &&
				blocks[n-1].Type == chunk.Type {
				blocks[n-1].Content += chunk.Content
			} else {
				blocks = append(blocks, provider.ContentBlock(chunk))
			}
			return nil, nil
		}

		// Submit drives the solicited turn. The provider derives fresh-turn
		// vs tool-result-continuation from req.Messages' trailing entries
		// itself, so there is no separate delivery call at this layer.
		//
		// Wrap the call in an osactivity assertion so macOS does not
		// App-Nap us mid-request. Refcounted, so nested HTTP calls in
		// providers that also assert compose without leaking. Released
		// in defer regardless of how the call returns (success, error,
		// panic), so we can never leave the assertion held when idle.
		osactivity.Begin()
		defer osactivity.End()

		result, err := conv.Submit(ctx, mreq, cb)
		if err != nil {
			return nil, err
		}

		// Convert accumulated blocks to the worker's LLMResponseBlock shape.
		responseBlocks := make([]worker.LLMResponseBlock, 0, len(blocks))
		for _, block := range blocks {
			var toolInput json.RawMessage
			if block.ToolInput != nil {
				toolInput, _ = json.Marshal(block.ToolInput)
			}
			responseBlocks = append(responseBlocks, worker.LLMResponseBlock{
				Type:     block.Type,
				Content:  block.Content,
				ID:       block.ToolUseID,
				Name:     block.ToolName,
				Input:    toolInput,
				Metadata: block.Metadata,
			})
		}

		return &worker.LLMResponse{
			Blocks:           responseBlocks,
			InputTokens:      result.InputTokens,
			OutputTokens:     result.OutputTokens,
			CachedTokens:     result.CachedTokens,
			CacheWriteTokens: result.CacheWriteTokens,
			StopReason:       result.StopReason,
			TransactionID:    req.TransactionID,
			CacheTTLMs:       conv.CacheTTL().Milliseconds(),
		}, nil
	}
}

// workerTurnSink routes a Conversation's autonomous turns to the owning worker
// as `provider-turn` inbound messages. One per conversation, built by the
// cache's turn-sink factory at open time and Subscribe()d onto the handle.
// DeliverTurn may be called from a provider-owned goroutine (claudecode's
// always-on stdout reader); Manager.HandleMessage hops onto the manager actor
// and the worker's inbound FIFO, so this is safe to call off the worker
// goroutine. A nil sendCallback is passed so no client callback is registered
// for this system-injected message.
type workerTurnSink struct {
	convID  string
	manager *worker.Manager
}

func (s *workerTurnSink) DeliverTurn(turn provider.ProviderTurn) {
	blocks := make([]worker.LLMResponseBlock, 0, len(turn.Blocks))
	for _, b := range turn.Blocks {
		var input json.RawMessage
		if b.ToolInput != nil {
			input, _ = json.Marshal(b.ToolInput)
		}
		blocks = append(blocks, worker.LLMResponseBlock{
			Type:     b.Type,
			Content:  b.Content,
			ID:       b.ToolUseID,
			Name:     b.ToolName,
			Input:    input,
			Metadata: b.Metadata,
		})
	}
	payload, err := json.Marshal(worker.ProviderTurnMessage{
		Type:             "provider-turn",
		Blocks:           blocks,
		StopReason:       turn.Result.StopReason,
		InputTokens:      turn.Result.InputTokens,
		OutputTokens:     turn.Result.OutputTokens,
		CachedTokens:     turn.Result.CachedTokens,
		CacheWriteTokens: turn.Result.CacheWriteTokens,
		Autonomous:       turn.Autonomous,
	})
	if err != nil {
		return
	}
	s.manager.HandleMessage(s.convID, "provider-turn", payload, nil)
}

// setupSessionRoutes configures session-related routes
func (s *Server) setupSessionRoutes(sessionAPI *handlers.SessionAPI) {
	api := s.router.PathPrefix("/api").Subrouter()

	// Session management (single session per folder)
	api.HandleFunc("/session", sessionAPI.HandleGetSession).Methods("GET")
	api.HandleFunc("/session", sessionAPI.HandleUpdateSession).Methods("PUT")
	api.HandleFunc("/session/metadata", sessionAPI.HandlePatchSessionMetadata).Methods("PATCH")
	// Native-window geometry lives with the session (per project), set/read by
	// the desktop app so each project's window reopens where it was left.
	api.HandleFunc("/session/window-state", sessionAPI.HandleGetWindowState).Methods("GET")
	api.HandleFunc("/session/window-state", sessionAPI.HandleSetWindowState).Methods("PUT")
	// Atomic conversation creation: server picks id, creates folder with
	// the collision-resolved canonical name, returns {id, name, created}.
	api.HandleFunc("/conversations", sessionAPI.HandleCreateConversation).Methods("POST")
	api.HandleFunc("/session/conversations/{convId}", sessionAPI.HandleGetConversation).Methods("GET")
	api.HandleFunc("/session/conversations/{convId}", sessionAPI.HandleUpdateConversation).Methods("PUT")
	api.HandleFunc("/session/conversations/{convId}", sessionAPI.HandleDeleteConversation).Methods("DELETE")
	api.HandleFunc("/session/conversations/{convId}/name", sessionAPI.HandleRenameConversation).Methods("PATCH")
	// Content-addressed binary assets (attached images, etc.) streamed from
	// <convDir>/assets/<sha>.<ext>. {sha} is validated as 64-char lowercase hex.
	api.HandleFunc("/session/conversations/{convId}/assets/{sha}", sessionAPI.HandleGetAsset).Methods("GET")
	// Upload raw image bytes (mime in Content-Type) → content-addressed store;
	// returns the AssetRef. Server-package handler: it needs worker.AssetStore.
	api.HandleFunc("/session/conversations/{convId}/assets", s.handleUploadAsset).Methods("POST")
	api.HandleFunc("/session/conversations/{convId}/bin", sessionAPI.HandleBinConversation).Methods("POST")
	api.HandleFunc("/session/binned-conversations", sessionAPI.HandleListBinnedConversations).Methods("GET")
	api.HandleFunc("/session/binned-conversations", sessionAPI.HandleEmptyBin).Methods("DELETE")
	api.HandleFunc("/session/binned-conversations/{convId}/restore", sessionAPI.HandleRestoreConversation).Methods("POST")
	api.HandleFunc("/session/binned-conversations/{convId}", sessionAPI.HandleDeleteBinnedConversation).Methods("DELETE")
	api.HandleFunc("/session/reorder", sessionAPI.HandleReorderConversations).Methods("PUT")
}

// setupProjectRoutes registers /api/project and /api/recents endpoints.
// These delegate to ProjectAPI which calls back into Server.SwitchProject.
func (s *Server) setupProjectRoutes() {
	api := s.router.PathPrefix("/api").Subrouter()
	projectAPI := handlers.NewProjectAPI(s.ProjectPath, s.SwitchProject, s.recentsStore)
	api.HandleFunc("/project", projectAPI.HandleGetProject).Methods("GET")
	api.HandleFunc("/project", projectAPI.HandlePostProject).Methods("POST")
	api.HandleFunc("/project", projectAPI.HandleDeleteProject).Methods("DELETE")
	api.HandleFunc("/project/check", projectAPI.HandleCheckProject).Methods("GET")
	api.HandleFunc("/recents", projectAPI.HandleGetRecents).Methods("GET")
	api.HandleFunc("/recents", projectAPI.HandleDeleteRecent).Methods("DELETE")
}

// setupConfigRoutes configures configuration-related routes
func (s *Server) setupConfigRoutes(configAPI *handlers.ConfigAPI) {
	api := s.router.PathPrefix("/api").Subrouter()

	// Configuration management
	api.HandleFunc("/config", configAPI.HandleGetConfig).Methods("GET")
	api.HandleFunc("/config", configAPI.HandleUpdateConfig).Methods("PUT")
	api.HandleFunc("/config/provider-enabled", configAPI.HandleSetProviderEnabled).Methods("POST")
	api.HandleFunc("/config/plugins", configAPI.HandleGetPluginConfig).Methods("GET")
	api.HandleFunc("/config/plugins", configAPI.HandleUpdatePluginConfig).Methods("PUT")

	// Default model new conversations are seeded with. GET returns the stored
	// value (or the computed preferred model when unset); PUT persists the
	// user's choice. Captured onto each conversation at creation time so a
	// later change never retargets an existing conversation.
	api.HandleFunc("/default-model", s.handleDefaultModel).Methods("GET")
	api.HandleFunc("/default-model", s.handleSetDefaultModel).Methods("PUT")

	// User-saved system-prompt presets + the chosen session-default preset id.
	// GET lists the user's presets (built-ins live in the frontend); POST saves
	// the current prompt as a new preset; DELETE removes one; PUT .../default
	// records which preset (built-in or user) new conversations seed from.
	// The /default route is registered before /{id} so it isn't shadowed.
	api.HandleFunc("/system-prompt-presets", s.handleGetSystemPromptPresets).Methods("GET")
	api.HandleFunc("/system-prompt-presets", s.handleCreateSystemPromptPreset).Methods("POST")
	api.HandleFunc("/system-prompt-presets/default", s.handleSetDefaultSystemPromptPreset).Methods("PUT")
	api.HandleFunc("/system-prompt-presets/{id}", s.handleDeleteSystemPromptPreset).Methods("DELETE")

	// Recently-selected concrete models, persisted server-side so the list
	// survives an app relaunch / a port change (browser localStorage is
	// origin-scoped). GET reads the MRU list; POST records a pick.
	api.HandleFunc("/recent-models", s.handleRecentModels).Methods("GET", "POST")
}

// RegisterTestRoutes registers test-specific API routes (called by testing wrapper)
//
// Each feature is matched against testAPI via a locally-declared structural
// interface (keeping this package free of the testing package's types). A
// failed match means signature drift between the two packages — the feature
// would silently unregister — so every miss is reported through
// mustMatch/panic rather than skipped. TestRegisterTestRoutesStructuralMatches
// additionally pins every match at test time.
func (s *Server) RegisterTestRoutes(testAPI any) {
	s.testMode = true
	api := s.router.PathPrefix("/api/test").Subrouter()

	// mustMatch makes a silently-failed structural assertion impossible: a
	// test-mode server missing a test feature is a broken test server, and a
	// panic at startup is the loudest possible acknowledgment.
	mustMatch := func(ok bool, feature string) {
		if !ok {
			panic(fmt.Sprintf("RegisterTestRoutes: testAPI does not satisfy the %s interface — "+
				"either a method signature drifted between the server and testing packages "+
				"(the feature would silently unregister), or this is a production-tagged build "+
				"whose testing stub has no handlers (--test is unsupported there)", feature))
		}
	}

	type taskAPI interface {
		HandleGetTask(w http.ResponseWriter, r *http.Request)
		HandleResetFixture(w http.ResponseWriter, r *http.Request)
		HandleDeleteFile(w http.ResponseWriter, r *http.Request)
		HandleMkdir(w http.ResponseWriter, r *http.Request)
		HandleDumpTape(w http.ResponseWriter, r *http.Request)
	}
	tapi, ok := testAPI.(taskAPI)
	mustMatch(ok, "task-API")
	api.HandleFunc("/task", tapi.HandleGetTask).Methods("GET")
	api.HandleFunc("/reset-fixture", tapi.HandleResetFixture).Methods("POST")
	api.HandleFunc("/delete-file", tapi.HandleDeleteFile).Methods("POST")
	api.HandleFunc("/mkdir", tapi.HandleMkdir).Methods("POST")
	api.HandleFunc("/dump-tape", tapi.HandleDumpTape).Methods("GET")

	// Wire the worker manager's tape dumper into the test API so the
	// dump-tape endpoint can surface per-conv worker tapes at failure
	// time. Passed as a func value so this package stays free of the
	// testing package's interface type (the two structurally-identical
	// interfaces would otherwise not satisfy method-signature equality).
	type tapeDumperSetter interface {
		SetTapeDumper(fn func(string) any)
	}
	tds, ok := testAPI.(tapeDumperSetter)
	mustMatch(ok, "tape-dumper")
	if s.workerManager != nil {
		tds.SetTapeDumper(s.workerManager.DumpTape)
	}

	// Conversation-ownership guard: in the multi-lane pool, a conversation may
	// only be deleted/binned by the lane that created it (cross-lane deletes
	// tear down a live test's worker mid-test). The ledger lives on the test
	// API; the session handlers consult it through these hooks, and the
	// owners endpoint lets the Go harness fail the run on leaked conversations.
	type convOwnershipAPI interface {
		RecordConvOwner(convID, lane string)
		CheckConvDelete(convID, lane string) error
		ReleaseConvOwner(convID string)
		HandleConversationOwners(w http.ResponseWriter, r *http.Request)
	}
	coa, ok := testAPI.(convOwnershipAPI)
	mustMatch(ok, "conversation-ownership")
	if s.sessionAPI == nil {
		panic("RegisterTestRoutes: sessionAPI is nil — the ownership guard cannot be wired " +
			"(a Server field assigned before the field-initialization block in New was lost?)")
	}
	s.sessionAPI.SetConvOwnershipHooks(coa.RecordConvOwner, coa.CheckConvDelete, coa.ReleaseConvOwner)
	api.HandleFunc("/conversation-owners", coa.HandleConversationOwners).Methods("GET")

	type runAPI interface {
		HandleRun(w http.ResponseWriter, r *http.Request)
		HandlePending(w http.ResponseWriter, r *http.Request)
		HandlePostResult(w http.ResponseWriter, r *http.Request)
		HandleGetResult(w http.ResponseWriter, r *http.Request)
		HandlePostNames(w http.ResponseWriter, r *http.Request)
		HandleGetNames(w http.ResponseWriter, r *http.Request)
		HandleJSTrace(w http.ResponseWriter, r *http.Request)
	}
	rapi, ok := testAPI.(runAPI)
	mustMatch(ok, "run-API")
	api.HandleFunc("/run", rapi.HandleRun).Methods("POST")
	api.HandleFunc("/pending", rapi.HandlePending).Methods("GET")
	api.HandleFunc("/result", rapi.HandlePostResult).Methods("POST")
	api.HandleFunc("/result", rapi.HandleGetResult).Methods("GET")
	api.HandleFunc("/names", rapi.HandlePostNames).Methods("POST")
	api.HandleFunc("/names", rapi.HandleGetNames).Methods("GET")
	api.HandleFunc("/jstrace", rapi.HandleJSTrace).Methods("POST")

	// Engine connection status — used by the JS test executor to wait for engine.
	s.router.HandleFunc("/api/engine/status", s.handleEngineStatus).Methods("GET")

	// Browser-side diagnostic logger — POST a JSON body and the message lands
	// in the subprocess stderr (captured per-fixture by main_test.go). Lets
	// integration tests trace what the browser is actually doing without
	// fighting the webview console.
	s.router.HandleFunc("/api/test/debug-log", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		fmt.Fprintf(os.Stderr, "[BROWSER-DEBUG] %s\n", body)
		w.WriteHeader(http.StatusNoContent)
	}).Methods("POST")

	// Headless test runner page (test binary only)
	s.router.HandleFunc("/headless-test", s.serveHeadlessTest).Methods("GET")

	// Test-pool host page: tiles N iframes of /headless-test for the
	// "one window, N iframes" stress topology.
	s.router.HandleFunc("/test-pool", s.serveTestPool).Methods("GET")
}

// SetTestLLMCaller sets a custom LLM caller for integration testing.
// This allows tests to mock the LLM provider while using real production routing.
func (s *Server) SetTestLLMCaller(fn worker.LLMCallFunc) {
	if s.workerManager != nil {
		s.workerManager.SetLLMCaller(fn)
	}
}

// setupRoutes configures all HTTP routes
func (s *Server) setupRoutes() {
	// API routes
	api := s.router.PathPrefix("/api").Subrouter()
	api.HandleFunc("/ws", s.handleWebSocket).Methods("GET")
	api.HandleFunc("/webrtc/signal", s.handleWebRTCSignal).Methods("POST")
	api.HandleFunc("/health", s.handleHealth).Methods("GET")
	api.HandleFunc("/health/active", s.handleHealthActive).Methods("GET")
	api.HandleFunc("/health/instance", s.handleHealthInstance).Methods("GET")
	api.HandleFunc("/shutdown", s.handleShutdown).Methods("POST")
	api.HandleFunc("/ops/call", s.opsAPI.HandleOperationCall).Methods("POST")
	api.HandleFunc("/completions/files", s.completionsAPI.HandleFileCompletions).Methods("GET")
	api.HandleFunc("/completions/path", s.completionsAPI.HandlePathCompletions).Methods("GET")
	api.HandleFunc("/completions/exists", s.completionsAPI.HandlePathExists).Methods("GET")
	api.HandleFunc("/git/status", s.gitStatusAPI.HandleGitStatus).Methods("GET")
	api.HandleFunc("/providers", s.handleProviders).Methods("GET")
	api.HandleFunc("/providers/refresh", s.handleRefreshProviders).Methods("POST")
	api.HandleFunc("/providers/usage", s.handleProviderUsageStats).Methods("GET")

	api.HandleFunc("/extensions", s.extensionsAPI.HandleListExtensions).Methods("GET")
	api.HandleFunc("/extensions/locations", s.extensionsAPI.HandleListLocations).Methods("GET")

	api.HandleFunc("/version", s.handleVersion).Methods("GET")
	api.HandleFunc("/update-status", s.handleUpdateStatus).Methods("GET")

	// Serve extension containers straight off disk. ExtensionsAPI owns these
	// paths; a "" path (e.g. no-project mode) simply registers no route.
	if userDir := s.extensionsAPI.UserExtensionDir(); userDir != "" {
		s.router.PathPrefix("/user-extensions/").Handler(
			http.StripPrefix("/user-extensions/", http.FileServer(http.Dir(userDir))),
		)
	}

	// Static file serving under version-prefixed paths for cache busting.
	// Production assets come from web.Files; the test-only js-tests/ tree comes
	// from web.TestFiles, which is empty under -tags production (see embed_testassets.go).
	vPrefix := "/v" + s.staticVersion
	prodPrefixes := []string{"/css/", "/js/", "/extensions/", "/sdk/", "/resources/"}
	// Captured so the absolute-project-path route below can reuse it. Serves the
	// web root, so a request path of "/js/foo.js" maps to web/js/foo.js.
	var staticFileServer http.Handler
	if s.devMode {
		// Development mode: serve files directly from disk for live reload
		staticDir, err := s.findStaticDir()
		if err != nil {
			jlog.Error("Failed to find static directory: %v", err)
			jlog.Error("Falling back to embedded files")
			staticFS, _ := fs.Sub(web.Files, ".")
			staticFileServer = http.FileServer(http.FS(staticFS))
			for _, prefix := range prodPrefixes {
				s.router.PathPrefix(vPrefix + prefix).Handler(http.StripPrefix(vPrefix, staticFileServer))
			}
			s.serveEmbeddedTestAssets(vPrefix)
		} else {
			jlog.Info("🔧 Dev mode: serving static files from %s", staticDir)
			staticFileServer = http.FileServer(http.Dir(staticDir))
			// Disk has js-tests/ alongside everything else, so serve it from disk too.
			for _, prefix := range append(prodPrefixes, "/js-tests/") {
				s.router.PathPrefix(vPrefix + prefix).Handler(http.StripPrefix(vPrefix, staticFileServer))
			}
		}
	} else {
		// Production mode: serve embedded files
		staticFS, err := fs.Sub(web.Files, ".")
		if err != nil {
			jlog.Error("Could not load static files: %v", err)
		}
		staticFileServer = http.FileServer(http.FS(staticFS))
		for _, prefix := range prodPrefixes {
			s.router.PathPrefix(vPrefix + prefix).Handler(http.StripPrefix(vPrefix, staticFileServer))
		}
		s.serveEmbeddedTestAssets(vPrefix)
	}

	// Absolute-project-path module loader for the explore_code sandbox worker.
	// The worker (opaque origin, no import map) resolves user code's
	// `import('<projectRoot>/web/...')` against its own http origin, producing a
	// request for `<projectRoot>/web/<rest>`. We serve that from the web root —
	// the server-side equivalent of the iframe import map's "<root>/web/" →
	// "/v<ver>/" rewrite. Matched dynamically because the project path is not
	// known at registration time; no project loaded ⇒ never matches.
	s.router.MatcherFunc(func(r *http.Request, _ *mux.RouteMatch) bool {
		root := s.ProjectPath()
		return root != "" && strings.HasPrefix(r.URL.Path, root+"/web/")
	}).HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if staticFileServer == nil {
			http.NotFound(w, r)
			return
		}
		rest := strings.TrimPrefix(r.URL.Path, s.ProjectPath()+"/web")
		r2 := r.Clone(r.Context())
		r2.URL.Path = rest
		r2.URL.RawPath = ""
		staticFileServer.ServeHTTP(w, r2)
	})

	// Worker-compatible module loader. Module workers don't inherit the page
	// import map, so the worker-backed engine (and every plugin module it pulls
	// in) resolves its public `juggler/*` SDK specifiers through this transform.
	s.router.HandleFunc("/worker-module", s.serveWorkerModule).Methods("GET")

	// Engine page route (headless browser for tool execution)
	s.router.HandleFunc("/engine", s.serveEngine).Methods("GET")
	s.router.HandleFunc("/sandbox", s.serveSandbox).Methods("GET")

	// Frontend → application-log bridge. Both the worker-backed engine runtime (as
	// it boots) and the viewer's chime path (rare untoward audio events) POST here;
	// their WebView consoles are invisible in a shipped build, so this is the only
	// window into either. See client_report.go.
	s.router.HandleFunc("/api/client/report", s.handleClientReport).Methods("POST")

	// Wails v3 runtime — served to every client (see wails_runtime.go).
	s.router.HandleFunc("/wails/runtime.js", s.handleWailsRuntime).Methods("GET")

	// Stub for the runtime's optional custom.js probe (a Wails server-mode
	// feature we don't use). 204 makes loadOptionalScript's `e.ok` false so
	// it skips injecting an empty <script>, and silences the console 404.
	s.router.HandleFunc("/wails/custom.js", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}).Methods("GET", "HEAD")

	// Favicon redirect to logo
	s.router.HandleFunc("/favicon.ico", s.serveFavicon).Methods("GET")

	// Serve index. /index.html serves the same templated app HTML as / so a
	// remote bootstrap page can fetch the real index over the DataChannel.
	s.router.HandleFunc("/", s.serveIndex).Methods("GET")
	s.router.HandleFunc("/index.html", s.serveIndex).Methods("GET")

	// Distribution seam: let a wrapping binary register additional routes
	// (see Config.ExtraRoutes). Runs last so built-in routes take precedence.
	if s.extraRoutes != nil {
		s.extraRoutes(s.router)
	}

	// Add middleware
	s.router.Use(corsMiddleware)
	s.router.Use(s.cacheControlMiddleware)
}

// serveEmbeddedTestAssets registers the version-prefixed /js-tests/ route from
// the embedded web.TestFiles. Under -tags production TestFiles is empty, so the
// route resolves to 404s — harmless, since RegisterTestRoutes is also gated off
// there and nothing references /js-tests/.
func (s *Server) serveEmbeddedTestAssets(vPrefix string) {
	testFS, err := fs.Sub(web.TestFiles, ".")
	if err != nil {
		jlog.Error("Could not load test assets: %v", err)
		return
	}
	fileServer := http.FileServer(http.FS(testFS))
	s.router.PathPrefix(vPrefix + "/js-tests/").Handler(http.StripPrefix(vPrefix, fileServer))
}
