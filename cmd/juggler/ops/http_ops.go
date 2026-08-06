//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
	"time"

	"juggler/internal/httpx"
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
	parsedURL, err := url.Parse(urlString)
	if err != nil || parsedURL.Hostname() == "" || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
		return nil, fmt.Errorf("url must be an absolute HTTP or HTTPS URL")
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
			return nil, err
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

	transport := httpx.Transport()
	if !allowPrivateHosts {
		proxyURL, err := httpx.Proxy(req)
		if err != nil {
			return nil, fmt.Errorf("failed to resolve HTTP proxy: %w", err)
		}
		if proxyURL == nil {
			transport.DialContext = publicDialContext
		}
	}
	client := &http.Client{Timeout: timeout, Transport: transport}
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if !followRedirects {
			return http.ErrUseLastResponse
		}
		if len(via) >= 10 {
			return fmt.Errorf("too many redirects")
		}
		if !allowPrivateHosts {
			if err := validatePublicHTTPHost(next.Context(), next.URL); err != nil {
				return err
			}
		}
		return nil
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, maxHTTPResponse+1))
	if err != nil {
		return nil, fmt.Errorf("failed to read HTTP response: %w", err)
	}
	truncated := len(responseBody) > maxHTTPResponse
	if truncated {
		responseBody = responseBody[:maxHTTPResponse]
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

func validatePublicHTTPHost(ctx context.Context, target *url.URL) error {
	host := target.Hostname()
	if strings.EqualFold(host, "localhost") {
		return fmt.Errorf("private, loopback, and link-local hosts require allowPrivateHosts")
	}

	var addresses []net.IP
	if literal := net.ParseIP(host); literal != nil {
		addresses = []net.IP{literal}
	} else {
		resolved, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return fmt.Errorf("failed to resolve HTTP host: %w", err)
		}
		for _, address := range resolved {
			addresses = append(addresses, address.IP)
		}
	}
	if len(addresses) == 0 {
		return fmt.Errorf("HTTP host resolved to no addresses")
	}
	for _, address := range addresses {
		if !publicIPAddress(address) {
			return fmt.Errorf("private, loopback, and link-local hosts require allowPrivateHosts")
		}
	}
	return nil
}

func publicIPAddress(ip net.IP) bool {
	return ip != nil && !ip.IsPrivate() && !ip.IsLoopback() &&
		!ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast() &&
		!ip.IsUnspecified() && !ip.IsMulticast()
}

func publicDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, fmt.Errorf("invalid HTTP address: %w", err)
	}
	resolved, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve HTTP host: %w", err)
	}
	if len(resolved) == 0 {
		return nil, fmt.Errorf("HTTP host resolved to no addresses")
	}
	var dialer net.Dialer
	var dialErrors []error
	for _, address := range resolved {
		if !publicIPAddress(address.IP) {
			return nil, fmt.Errorf("private, loopback, and link-local hosts require allowPrivateHosts")
		}
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(address.IP.String(), port))
		if err == nil {
			return conn, nil
		}
		dialErrors = append(dialErrors, err)
	}
	return nil, errors.Join(dialErrors...)
}
