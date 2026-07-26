//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"reflect"
	"testing"
)

func TestEnvWithOverride(t *testing.T) {
	t.Parallel()

	got := envWithOverride([]string{
		"HOME=/tmp/home",
		"JUGGLER_CONFIG_DIR=/real/profile",
		"PATH=/bin",
		"JUGGLER_CONFIG_DIR=/other/profile",
	}, "JUGGLER_CONFIG_DIR", "/tmp/test-profile")
	want := []string{
		"HOME=/tmp/home",
		"PATH=/bin",
		"JUGGLER_CONFIG_DIR=/tmp/test-profile",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("envWithOverride() = %q, want %q", got, want)
	}
}
