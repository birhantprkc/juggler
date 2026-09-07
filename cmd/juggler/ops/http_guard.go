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
	"net/url"
	"strings"
	"time"

	"juggler/internal/httpx"
)

// The shared network posture for every op that fetches a URL the caller chose —
// http request, webfetch and websearch. All three take a URL the model or an
// extension supplies, so all three are a way to reach the machine Juggler runs
// on and the network around it: a cloud metadata endpoint, a router admin page,
// a database bound to loopback. One set of rules governs them:
//
//   - the URL must be absolute http or https, so no other scheme reaches the
//     transport (parseFetchURL);
//   - the host must resolve exclusively to public addresses, checked before the
//     request is sent (validatePublicHTTPHost);
//   - the dial re-checks, so a name that resolves public once and private the
//     second time still cannot be reached (publicDialContext);
//   - every redirect hop is checked like the original URL;
//   - the response body is capped (readCappedBody).
//
// Only the http op waives it, through its documented allowPrivateHosts
// parameter — that is how a local model server or a dev server is reached.
//
// The dial guard is installed only for a direct connection. Behind a proxy it
// is the proxy that resolves and connects to the target, so guarding our own
// dial would only test the proxy's address, which is commonly private itself.

// errPrivateHost is the single blocked-destination error. The http op tests for
// it with errors.Is to add the parameter that waives it.
var errPrivateHost = errors.New("private, loopback, and link-local hosts are blocked")

// parseFetchURL validates a caller-supplied URL as an absolute HTTP(S) target.
func parseFetchURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, fmt.Errorf("url must be an absolute HTTP or HTTPS URL")
	}
	return parsed, nil
}

// fetchClientOptions configures one outbound fetch. checkRedirect, when set,
// runs before the shared hop-count and host checks so a caller can refuse a
// redirect outright or stop following with http.ErrUseLastResponse.
type fetchClientOptions struct {
	timeout       time.Duration
	allowPrivate  bool
	checkRedirect func(next *http.Request, via []*http.Request) error
}

// newFetchClient builds the client for req under the posture described above.
func newFetchClient(req *http.Request, opts fetchClientOptions) (*http.Client, error) {
	transport := httpx.Transport()
	if !opts.allowPrivate {
		proxyURL, err := httpx.Proxy(req)
		if err != nil {
			return nil, fmt.Errorf("failed to resolve HTTP proxy: %w", err)
		}
		if proxyURL == nil {
			transport.DialContext = publicDialContext
		}
	}
	return &http.Client{
		Timeout:   opts.timeout,
		Transport: transport,
		CheckRedirect: func(next *http.Request, via []*http.Request) error {
			if opts.checkRedirect != nil {
				if err := opts.checkRedirect(next, via); err != nil {
					return err
				}
			}
			if len(via) >= 10 {
				return fmt.Errorf("too many redirects")
			}
			if opts.allowPrivate {
				return nil
			}
			return validatePublicHTTPHost(next.Context(), next.URL)
		},
	}, nil
}

// readCappedBody reads at most limit bytes from r, reporting whether more were
// there. A response body is attacker-chosen in length as much as in content.
func readCappedBody(r io.Reader, limit int) ([]byte, bool, error) {
	body, err := io.ReadAll(io.LimitReader(r, int64(limit)+1))
	if err != nil {
		return nil, false, err
	}
	if len(body) > limit {
		return body[:limit], true, nil
	}
	return body, false, nil
}

// validatePublicHTTPHost resolves target's host and rejects it unless every
// address it answers to is publicly routable.
func validatePublicHTTPHost(ctx context.Context, target *url.URL) error {
	host := target.Hostname()
	if strings.EqualFold(host, "localhost") {
		return errPrivateHost
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
			return errPrivateHost
		}
	}
	return nil
}

func publicIPAddress(ip net.IP) bool {
	return ip != nil && !ip.IsPrivate() && !ip.IsLoopback() &&
		!ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast() &&
		!ip.IsUnspecified() && !ip.IsMulticast()
}

// publicDialContext is the transport-level half of the guard: it resolves the
// address again at dial time and refuses any private answer.
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
			return nil, errPrivateHost
		}
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(address.IP.String(), port))
		if err == nil {
			return conn, nil
		}
		dialErrors = append(dialErrors, err)
	}
	return nil, errors.Join(dialErrors...)
}
