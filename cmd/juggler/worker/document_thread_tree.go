//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	ycrdt "github.com/skyterra/y-crdt"
)

// walkThreads visits every thread Y.Map in arr, depth-first. The visitor receives
// the thread Y.Map, its nested "items" Y.Array (may be nil), and the itemId of
// the enclosing parent thread ("" at root level). Return true to stop early.
// walkThreads itself returns true if walking was stopped early by the visitor.
func walkThreads(arr *ycrdt.YArray, visit func(m *ycrdt.YMap, nested *ycrdt.YArray, parentThreadID string) bool) bool {
	return walkThreadsWithParent(arr, "", visit)
}

func walkThreadsWithParent(arr *ycrdt.YArray, parentID string, visit func(m *ycrdt.YMap, nested *ycrdt.YArray, parentThreadID string) bool) bool {
	if arr == nil {
		return false
	}
	for i := range int(arr.GetLength()) {
		m, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		if itemType, _ := m.Get("type").(string); itemType != ItemTypeThread {
			continue
		}
		nested, _ := m.Get("items").(*ycrdt.YArray)
		if visit(m, nested, parentID) {
			return true
		}
		myID, _ := m.Get("itemId").(string)
		if walkThreadsWithParent(nested, myID, visit) {
			return true
		}
	}
	return false
}

// walkAllItems visits every Y.Map in arr (regardless of type), depth-first, and
// recurses into thread children. The visitor receives the Y.Map and the itemId
// of the enclosing thread ("" at root level). Return true to stop early.
func walkAllItems(arr *ycrdt.YArray, currentThreadID string, visit func(m *ycrdt.YMap, currentThreadID string) bool) bool {
	if arr == nil {
		return false
	}
	for i := range int(arr.GetLength()) {
		m, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		if visit(m, currentThreadID) {
			return true
		}
		if itemType, _ := m.Get("type").(string); itemType == ItemTypeThread {
			if nested, _ := m.Get("items").(*ycrdt.YArray); nested != nil {
				myID, _ := m.Get("itemId").(string)
				if walkAllItems(nested, myID, visit) {
					return true
				}
			}
		}
	}
	return false
}

// GetThreadItemsArray finds a thread Y.Map by itemId and returns its nested
// "items" Y.Array. Searches recursively through nested threads.
func (cd *ConversationDocument) GetThreadItemsArray(threadItemID string) *ycrdt.YArray {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return findThreadItemsArray(cd.getItems(), threadItemID)
}

// findThreadItemsArray returns the nested "items" Y.Array for the thread with the given itemId.
func findThreadItemsArray(arr *ycrdt.YArray, threadItemID string) *ycrdt.YArray {
	var result *ycrdt.YArray
	walkThreads(arr, func(m *ycrdt.YMap, nested *ycrdt.YArray, _ string) bool {
		if id, _ := m.Get("itemId").(string); id == threadItemID {
			result = nested
			return true
		}
		return false
	})
	return result
}

// GetThreadYMap finds a thread Y.Map by itemId. Searches recursively.
// Returns the Y.Map container for the thread, or nil if not found.
func (cd *ConversationDocument) GetThreadYMap(threadItemID string) *ycrdt.YMap {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return findThreadYMap(cd.getItems(), threadItemID)
}

// findThreadYMap returns the Y.Map for the thread with the given itemId.
func findThreadYMap(arr *ycrdt.YArray, threadItemID string) *ycrdt.YMap {
	var result *ycrdt.YMap
	walkThreads(arr, func(m *ycrdt.YMap, _ *ycrdt.YArray, _ string) bool {
		if id, _ := m.Get("itemId").(string); id == threadItemID {
			result = m
			return true
		}
		return false
	})
	return result
}

// findParentThreadID returns the itemId of the parent thread containing threadItemID.
// Returns "" if the thread is at root level or not found.
func (cd *ConversationDocument) findParentThreadID(threadItemID string) string {
	var result string
	walkThreads(cd.getItems(), func(m *ycrdt.YMap, _ *ycrdt.YArray, parent string) bool {
		if id, _ := m.Get("itemId").(string); id == threadItemID {
			result = parent
			return true
		}
		return false
	})
	return result
}

// threadDepth returns how deeply the given thread is nested: the root level
// ("") is depth 0, a thread directly under root is depth 1, its child depth 2,
// and so on. Walks the parent chain via findParentThreadID under a single lock.
func (cd *ConversationDocument) threadDepth(threadItemID string) int {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	depth := 0
	for tid := threadItemID; tid != ""; tid = cd.findParentThreadID(tid) {
		depth++
	}
	return depth
}

// FindThreadIDForToolUseID returns the threadItemID of the thread containing
// the given toolUseId, or "" if it lives in the root array.
// Returns ("", false) if not found anywhere.
func (cd *ConversationDocument) FindThreadIDForToolUseID(toolUseID string) (threadID string, found bool) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return findThreadIDForToolUseID(cd.getItems(), toolUseID)
}

func findThreadIDForToolUseID(arr *ycrdt.YArray, toolUseID string) (string, bool) {
	var resultThreadID string
	found := walkAllItems(arr, "", func(m *ycrdt.YMap, currentThreadID string) bool {
		if id, _ := m.Get("toolUseId").(string); id == toolUseID {
			resultThreadID = currentThreadID
			return true
		}
		return false
	})
	return resultThreadID, found
}

// UpdateToolActionFieldsRecursive searches all arrays (root + nested threads)
// for an item with the given toolUseId and updates its fields in one transaction.
// Returns true if the item was found and updated.
func (cd *ConversationDocument) UpdateToolActionFieldsRecursive(toolUseID string, fields map[string]any) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return updateToolActionFieldsInArray(cd.doc, docInternalOrigin, cd.getItems(), toolUseID, fields)
}

// updateToolActionFieldsInArray finds the Y.Map whose toolUseId matches and updates all fields atomically.
func updateToolActionFieldsInArray(doc *ycrdt.Doc, origin string, arr *ycrdt.YArray, toolUseID string, fields map[string]any) bool {
	return walkAllItems(arr, "", func(m *ycrdt.YMap, _ string) bool {
		if id, _ := m.Get("toolUseId").(string); id != toolUseID {
			return false
		}
		doc.Transact(func(_ *ycrdt.Transaction) {
			for field, value := range fields {
				m.Set(field, convertToYcrdt(value))
			}
		}, origin)
		return true
	})
}

// UpdateToolActionByItemIDRecursive searches all arrays (root + nested threads)
// for the first tool-action whose itemId matches and updates its fields.
// Returns true if the item was found and updated.
func (cd *ConversationDocument) UpdateToolActionByItemIDRecursive(itemID string, fields map[string]any) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return updateToolActionByItemIDInArray(cd.doc, docInternalOrigin, cd.getItems(), itemID, fields)
}

func updateToolActionByItemIDInArray(doc *ycrdt.Doc, origin string, arr *ycrdt.YArray, itemID string, fields map[string]any) bool {
	return walkAllItems(arr, "", func(m *ycrdt.YMap, _ string) bool {
		if id, _ := m.Get("itemId").(string); id != itemID {
			return false
		}
		if t, _ := m.Get("type").(string); t != ItemTypeToolAction {
			return false
		}
		doc.Transact(func(_ *ycrdt.Transaction) {
			for field, value := range fields {
				m.Set(field, convertToYcrdt(value))
			}
		}, origin)
		return true
	})
}

// extractModelConfigFromMap extracts a concrete {provider, model} ModelConfig
// from a map or Y.Map value. A missing or incomplete pair returns nil so the
// caller's "please select a model" guard still trips, exactly as if no config
// were present.
func (cd *ConversationDocument) extractModelConfigFromMap(raw any) *ModelConfig {
	switch v := raw.(type) {
	case *ycrdt.YMap:
		provider, _ := v.Get("provider").(string)
		model, _ := v.Get("model").(string)
		if provider != "" && model != "" {
			return &ModelConfig{Provider: provider, Model: model}
		}
	case map[string]any:
		provider, _ := v["provider"].(string)
		model, _ := v["model"].(string)
		if provider != "" && model != "" {
			return &ModelConfig{Provider: provider, Model: model}
		}
	}
	return nil
}

// ResolveEffectiveStrategyID resolves the strategy id for a thread by walking up
// the parent chain: thread Y.Map `currentStrategyId` → parent thread → ... → doc
// metadata `currentStrategyId`. A missing/empty value normalizes to
// defaultStrategyID. Mirrors ResolveEffectiveModelConfig — a sub-thread inherits
// the conversation's strategy unless it carries its own override.
func (cd *ConversationDocument) ResolveEffectiveStrategyID(threadItemID string) string {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return cd.resolveEffectiveStrategyID(threadItemID)
}

func (cd *ConversationDocument) resolveEffectiveStrategyID(threadItemID string) string {
	if threadItemID != "" {
		if threadMap := findThreadYMap(cd.getItems(), threadItemID); threadMap != nil {
			if s, _ := threadMap.Get("currentStrategyId").(string); s != "" {
				return s
			}
		}
		if parentID := cd.findParentThreadID(threadItemID); parentID != "" {
			return cd.resolveEffectiveStrategyID(parentID)
		}
	}
	if s, _ := cd.metadata.Get("currentStrategyId").(string); s != "" {
		return s
	}
	return defaultStrategyID
}

// GetActivatedStrategyID returns the strategy id whose onActivate hook has
// already run for this thread — the per-thread activation marker. Root uses doc
// metadata (it has no Y.Map of its own); a sub-thread uses its own Y.Map. The
// marker is NOT inherited: each thread activates its own effective strategy
// exactly once.
func (cd *ConversationDocument) GetActivatedStrategyID(threadItemID string) string {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	if threadItemID == "" {
		s, _ := cd.metadata.Get("activatedStrategyId").(string)
		return s
	}
	if m := findThreadYMap(cd.getItems(), threadItemID); m != nil {
		s, _ := m.Get("activatedStrategyId").(string)
		return s
	}
	return ""
}

// SetActivatedStrategyID records that this thread has run its onActivate hook for
// strategyID. Root → doc metadata; sub-thread → its own Y.Map. Delegates to the
// self-locking SetMetadata / SetThreadField, so callers must NOT hold ycrdtMu.
func (cd *ConversationDocument) SetActivatedStrategyID(threadItemID, strategyID string) {
	if threadItemID == "" {
		cd.SetMetadata("activatedStrategyId", strategyID)
		return
	}
	cd.SetThreadField(threadItemID, "activatedStrategyId", strategyID)
}

// ResolveEffectiveModelConfig resolves the model config for a thread by walking
// up the parent chain. Checks thread Y.Map → parent thread → ... → doc metadata.
func (cd *ConversationDocument) ResolveEffectiveModelConfig(threadItemID string) *ModelConfig {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return cd.resolveEffectiveModelConfig(threadItemID)
}

func (cd *ConversationDocument) resolveEffectiveModelConfig(threadItemID string) *ModelConfig {
	if threadItemID != "" {
		threadMap := findThreadYMap(cd.getItems(), threadItemID)
		if threadMap != nil {
			raw := threadMap.Get("modelConfig")
			if mc := cd.extractModelConfigFromMap(raw); mc != nil {
				return mc
			}
		}

		parentID := cd.findParentThreadID(threadItemID)
		if parentID != "" {
			return cd.resolveEffectiveModelConfig(parentID)
		}
	}

	// Conversation-level DEFAULT lives under `defaultModelConfig`; the
	// thread-level override key (read above) stays `modelConfig`.
	raw := cd.metadata.Get("defaultModelConfig")
	if raw == nil {
		return nil
	}
	// Route through the same shape-aware extractor used for thread-level
	// configs so the doc metadata resolves identically.
	if mc := cd.extractModelConfigFromMap(raw); mc != nil {
		return mc
	}
	converted := fromYcrdt(raw)
	if mc, ok := converted.(map[string]any); ok {
		provider, _ := mc["provider"].(string)
		model, _ := mc["model"].(string)
		if provider != "" && model != "" {
			return &ModelConfig{Provider: provider, Model: model}
		}
	}
	return nil
}
