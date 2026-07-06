//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"fmt"
)

// Operations is the interface that all operation handlers must implement.
// ctx is the request context: handlers running unbounded work (filesystem
// walks, network fetches) should honor ctx.Err()/ctx.Done() so a cancelled
// HTTP request (the browser aborting the op fetch on Escape) stops the work
// instead of running it to completion.
type Operations interface {
	Execute(ctx context.Context, operation string, params map[string]any) (any, error)
}

// Factory is a function that creates an operation handler instance
type Factory func(scope PathScope) Operations

// registry maps tool IDs to their factory functions
var registry = make(map[string]Factory)

// Register registers an operation handler factory
func Register(toolID string, factory Factory) {
	registry[toolID] = factory
}

// GetGlobal retrieves an operation handler factory by tool ID
func GetGlobal(toolID string) (Factory, error) {
	factory, ok := registry[toolID]
	if !ok {
		return nil, fmt.Errorf("operation handler not found for tool: %s", toolID)
	}
	return factory, nil
}
