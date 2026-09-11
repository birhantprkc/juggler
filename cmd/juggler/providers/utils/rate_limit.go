//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

// MaxRateLimitHint bounds what a provider is allowed to tell us to wait. A
// garbled or hostile number would otherwise stand over a conversation for
// years. Clamping rather than discarding is deliberate: a hint that is too long
// to be true still says "this is a cap, not a throttle", and a clamp at worst
// makes us ask again early, whereas discarding it puts us back to guessing two
// seconds — the one reading that is always wrong.
const MaxRateLimitHint = 24 * time.Hour

// rateLimitBodyFields are the JSON fields a 429 body states its reset in, in
// the order they are trusted. The relative ones lead: they are measured from
// the response we are holding, so they survive a clock that disagrees with the
// provider's. `resets_at`/`resets_in_seconds` are what a ChatGPT-subscription
// usage cap returns; the `retry_after` spellings are the common gateway ones.
var rateLimitBodyFields = []struct {
	name     string
	absolute bool // a unix timestamp rather than a number of seconds
}{
	{name: "resets_in_seconds"},
	{name: "retry_after_seconds"},
	{name: "retry_after"},
	{name: "resets_at", absolute: true},
}

// ParseRateLimitHint reports how long a provider said to wait before trying
// again, reading the `Retry-After` header and the response body. It returns 0
// when the provider said nothing — which a caller must not confuse with "try
// again shortly": the two differ by four hours on a usage cap.
//
// body may be the raw JSON or any larger string containing it (an SDK error's
// text embeds the body it was built from), so the fields are located in place
// rather than by unmarshalling.
func ParseRateLimitHint(header http.Header, body string) time.Duration {
	return parseRateLimitHint(header, body, time.Now())
}

func parseRateLimitHint(header http.Header, body string, now time.Time) time.Duration {
	for _, field := range rateLimitBodyFields {
		if v, ok := jsonNumberField(body, field.name); ok {
			if field.absolute {
				return clampRateLimitHint(time.Unix(int64(v), 0).Sub(now))
			}
			return clampRateLimitHint(time.Duration(v * float64(time.Second)))
		}
	}
	return clampRateLimitHint(retryAfterHeader(header, now))
}

// retryAfterHeader reads RFC 9110's Retry-After, which is either delta-seconds
// or an HTTP-date.
func retryAfterHeader(header http.Header, now time.Time) time.Duration {
	raw := strings.TrimSpace(header.Get("Retry-After"))
	if raw == "" {
		return 0
	}
	if secs, err := strconv.ParseFloat(raw, 64); err == nil {
		return time.Duration(secs * float64(time.Second))
	}
	if at, err := http.ParseTime(raw); err == nil {
		return at.Sub(now)
	}
	return 0
}

// clampRateLimitHint normalises a parsed hint: a wait already elapsed, or one
// beyond anything credible, is not a hint the caller can act on.
func clampRateLimitHint(d time.Duration) time.Duration {
	if d <= 0 {
		return 0
	}
	return min(d, MaxRateLimitHint)
}

// jsonNumberField finds `"name": <number>` in s and returns the number. The
// value may be quoted, as some gateways stringify their numbers.
func jsonNumberField(s, name string) (float64, bool) {
	rest, found := strings.CutPrefix(afterKey(s, `"`+name+`"`), ":")
	if !found {
		return 0, false
	}
	rest = strings.TrimLeft(rest, " \t\r\n")
	rest = strings.TrimPrefix(rest, `"`)
	end := 0
	for end < len(rest) && (rest[end] == '.' || rest[end] == '-' || rest[end] == '+' ||
		rest[end] == 'e' || rest[end] == 'E' || (rest[end] >= '0' && rest[end] <= '9')) {
		end++
	}
	v, err := strconv.ParseFloat(rest[:end], 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// afterKey returns what follows key in s, with surrounding space trimmed, or ""
// when key is absent.
func afterKey(s, key string) string {
	i := strings.Index(s, key)
	if i < 0 {
		return ""
	}
	return strings.TrimLeft(s[i+len(key):], " \t\r\n")
}
