//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/textproto"
	"strings"
	"time"
)

const (
	defaultHTTPTimeout = 30 * time.Second
	maxHTTPTimeout     = 120 * time.Second
	maxHTTPResponse    = 4 << 20 // 4 MiB
)

var allowedHTTPMethods = map[string]bool{
	http.MethodGet: true, http.MethodPost: true, http.MethodPut: true,
	http.MethodPatch: true, http.MethodDelete: true, http.MethodHead: true,
}

// HTTPOperations provides general server-side HTTP requests for extensions.
type HTTPOperations struct {
	scope PathScope
}

// NewHTTPOperations creates an HTTP operations handler.
func NewHTTPOperations(scope PathScope) *HTTPOperations {
	return &HTTPOperations{scope: scope}
}

// Execute dispatches an HTTP operation by name.
func (o *HTTPOperations) Execute(ctx context.Context, operation string, params map[string]any) (any, error) {
	if operation != "request" {
		return nil, fmt.Errorf("unknown operation: %s", operation)
	}
	return o.request(ctx, params)
}

func (o *HTTPOperations) request(ctx context.Context, params map[string]any) (any, error) {
	method := http.MethodGet
	if raw, ok := params["method"]; ok {
		var valid bool
		method, valid = raw.(string)
		method = strings.ToUpper(method)
		if !valid || !allowedHTTPMethods[method] {
			return nil, fmt.Errorf("unsupported HTTP method")
		}
	}

	urlString, ok := params["url"].(string)
	if !ok || urlString == "" {
		return nil, fmt.Errorf("missing url parameter")
	}
	parsedURL, err := parseFetchURL(urlString)
	if err != nil {
		return nil, err
	}

	body, ok := optionalString(params, "body")
	if !ok {
		return nil, fmt.Errorf("body must be a string")
	}
	headers, err := stringMap(params, "headers")
	if err != nil {
		return nil, err
	}
	timeout, err := httpTimeout(params)
	if err != nil {
		return nil, err
	}
	followRedirects, err := optionalBool(params, "followRedirects", true)
	if err != nil {
		return nil, err
	}
	allowPrivateHosts, err := optionalBool(params, "allowPrivateHosts", false)
	if err != nil {
		return nil, err
	}

	if !allowPrivateHosts {
		if err := validatePublicHTTPHost(ctx, parsedURL); err != nil {
			return nil, withAllowPrivateHostsHint(err)
		}
	}

	req, err := http.NewRequestWithContext(ctx, method, parsedURL.String(), strings.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create HTTP request: %w", err)
	}
	for name, value := range headers {
		if !validHTTPHeader(name, value) {
			return nil, fmt.Errorf("invalid HTTP header")
		}
		req.Header.Set(name, value)
	}

	client, err := newFetchClient(req, fetchClientOptions{
		timeout:      timeout,
		allowPrivate: allowPrivateHosts,
		checkRedirect: func(*http.Request, []*http.Request) error {
			if !followRedirects {
				return http.ErrUseLastResponse
			}
			return nil
		},
	})
	if err != nil {
		return nil, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, withAllowPrivateHostsHint(fmt.Errorf("HTTP request failed: %w", err))
	}
	defer resp.Body.Close()

	responseBody, truncated, err := readCappedBody(resp.Body, maxHTTPResponse)
	if err != nil {
		return nil, fmt.Errorf("failed to read HTTP response: %w", err)
	}

	responseHeaders := make(map[string]string, len(resp.Header))
	for name, values := range resp.Header {
		responseHeaders[name] = strings.Join(values, ", ")
	}
	statusText := strings.TrimSpace(strings.TrimPrefix(resp.Status, fmt.Sprintf("%d", resp.StatusCode)))
	return map[string]any{
		"status":     resp.StatusCode,
		"statusText": statusText,
		"headers":    responseHeaders,
		"body":       string(responseBody),
		"truncated":  truncated,
	}, nil
}

func optionalString(params map[string]any, key string) (string, bool) {
	value, exists := params[key]
	if !exists {
		return "", true
	}
	result, ok := value.(string)
	return result, ok
}

func stringMap(params map[string]any, key string) (map[string]string, error) {
	value, exists := params[key]
	if !exists {
		return nil, nil
	}
	raw, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an object of string values", key)
	}
	result := make(map[string]string, len(raw))
	for name, value := range raw {
		text, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("%s must contain only string values", key)
		}
		result[name] = text
	}
	return result, nil
}

func optionalBool(params map[string]any, key string, fallback bool) (bool, error) {
	value, exists := params[key]
	if !exists {
		return fallback, nil
	}
	result, ok := value.(bool)
	if !ok {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return result, nil
}

func httpTimeout(params map[string]any) (time.Duration, error) {
	value, exists := params["timeoutMs"]
	if !exists {
		return defaultHTTPTimeout, nil
	}
	milliseconds, ok := value.(float64)
	if !ok || milliseconds <= 0 || milliseconds != float64(int64(milliseconds)) {
		return 0, fmt.Errorf("timeoutMs must be a positive integer")
	}
	timeout := time.Duration(milliseconds) * time.Millisecond
	if timeout > maxHTTPTimeout {
		return 0, fmt.Errorf("timeoutMs must not exceed %d", maxHTTPTimeout/time.Millisecond)
	}
	return timeout, nil
}

func validHTTPHeader(name, value string) bool {
	return textproto.TrimString(name) == name && textproto.CanonicalMIMEHeaderKey(name) != "" &&
		!strings.ContainsAny(value, "\r\n")
}

// withAllowPrivateHostsHint names the parameter that waives the shared
// blocked-destination rule. Only this op has one, so only this op says so.
func withAllowPrivateHostsHint(err error) error {
	if errors.Is(err, errPrivateHost) {
		return fmt.Errorf("%w: set allowPrivateHosts to reach them", err)
	}
	return err
}
