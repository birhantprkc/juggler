//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// WebSearchOperations handles web search functionality
type WebSearchOperations struct {
	scope PathScope
}

// NewWebSearchOperations creates a new web search operations handler
func NewWebSearchOperations(scope PathScope) *WebSearchOperations {
	return &WebSearchOperations{
		scope: scope,
	}
}

// Execute executes a web search operation
func (ops *WebSearchOperations) Execute(ctx context.Context, operation string, params map[string]any) (any, error) {
	switch operation {
	case "search":
		return ops.search(ctx, params)
	default:
		return nil, fmt.Errorf("unknown operation: %s", operation)
	}
}

// searchMethods are the two verbs a search endpoint needs: GET for a query
// string, POST for a form. The proxy is not a general-purpose HTTP client — the
// `http` op is, and it is the one with the parameters to be trusted with more.
var searchMethods = map[string]bool{http.MethodGet: true, http.MethodPost: true}

// search acts as a CORS proxy - frontend passes URL, we fetch and return raw
// content. The URL comes from the caller, so it is held to the same posture as
// every other fetching op (see http_guard.go).
func (ops *WebSearchOperations) search(ctx context.Context, params map[string]any) (any, error) {
	// Frontend passes the full search URL
	urlStr, ok := params["url"].(string)
	if !ok || urlStr == "" {
		return nil, fmt.Errorf("missing url parameter")
	}

	// For POST requests (DuckDuckGo), accept form data
	method := http.MethodGet
	if raw, exists := params["method"]; exists {
		text, valid := raw.(string)
		method = strings.ToUpper(text)
		if !valid || !searchMethods[method] {
			return nil, fmt.Errorf("unsupported HTTP method")
		}
	}

	parsedURL, err := parseFetchURL(urlStr)
	if err != nil {
		return nil, err
	}
	if err := validatePublicHTTPHost(ctx, parsedURL); err != nil {
		return nil, err
	}

	var body io.Reader
	if formData, ok := params["form_data"].(map[string]any); ok && method == http.MethodPost {
		data := url.Values{}
		for k, v := range formData {
			data.Set(k, fmt.Sprintf("%v", v))
		}
		body = strings.NewReader(data.Encode())
	}

	// Create HTTP request
	req, err := http.NewRequestWithContext(ctx, method, parsedURL.String(), body)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Set headers
	if method == http.MethodPost {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	req.Header.Set("User-Agent", "Juggler/1.0 (AI Coding Assistant)")
	req.Header.Set("Accept", "application/json, text/html, */*")

	// Execute request (like webfetch does), proxy-aware.
	client, err := newFetchClient(req, fetchClientOptions{timeout: 30 * time.Second})
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP error: %d", resp.StatusCode)
	}

	// Read and return raw response
	bodyBytes, truncated, err := readCappedBody(resp.Body, maxHTTPResponse)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	return map[string]any{
		"url":       urlStr,
		"content":   string(bodyBytes),
		"status":    resp.StatusCode,
		"truncated": truncated,
	}, nil
}
