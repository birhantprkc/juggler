//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package helpers

import (
	"strings"
	"testing"
)

// AssertEqual checks if two values are equal
func AssertEqual(t *testing.T, got, want any) {
	t.Helper()
	if got != want {
		t.Errorf("got %v, want %v", got, want)
	}
}

// AssertNotEqual checks if two values are not equal
func AssertNotEqual(t *testing.T, got, want any) {
	t.Helper()
	if got == want {
		t.Errorf("got %v, expected it to not equal %v", got, want)
	}
}

// AssertNoError checks that an error is nil
func AssertNoError(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// AssertError checks that an error is not nil
func AssertError(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("expected error but got nil")
	}
}

// AssertErrorContains checks that an error contains a substring
func AssertErrorContains(t *testing.T, err error, substr string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error containing %q but got nil", substr)
	}
	if !strings.Contains(err.Error(), substr) {
		t.Errorf("error %q does not contain %q", err.Error(), substr)
	}
}

// AssertContains checks if haystack contains needle
func AssertContains(t *testing.T, haystack, needle string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Errorf("expected %q to contain %q", haystack, needle)
	}
}

// AssertNotContains checks if haystack does not contain needle
func AssertNotContains(t *testing.T, haystack, needle string) {
	t.Helper()
	if strings.Contains(haystack, needle) {
		t.Errorf("expected %q to not contain %q", haystack, needle)
	}
}

// AssertTrue checks if a condition is true
func AssertTrue(t *testing.T, condition bool, msg string) {
	t.Helper()
	if !condition {
		t.Errorf("expected condition to be true: %s", msg)
	}
}

// AssertFalse checks if a condition is false
func AssertFalse(t *testing.T, condition bool, msg string) {
	t.Helper()
	if condition {
		t.Errorf("expected condition to be false: %s", msg)
	}
}

// AssertNil checks if a value is nil
func AssertNil(t *testing.T, value any) {
	t.Helper()
	if value != nil {
		// Check if it's a typed nil (e.g., (*Fact)(nil))
		switch v := value.(type) {
		case nil:
			return
		default:
			t.Errorf("expected nil but got %v (type: %T)", v, v)
		}
	}
}

// AssertNotNil checks if a value is not nil
func AssertNotNil(t *testing.T, value any) {
	t.Helper()
	if value == nil {
		t.Fatal("expected non-nil value but got nil")
	}
}

// AssertLen checks if a slice/map/string has expected length
func AssertLen(t *testing.T, obj any, expectedLen int) {
	t.Helper()
	var actualLen int
	switch v := obj.(type) {
	case string:
		actualLen = len(v)
	case []any:
		actualLen = len(v)
	case map[string]any:
		actualLen = len(v)
	default:
		t.Fatalf("AssertLen: unsupported type %T", obj)
	}

	if actualLen != expectedLen {
		t.Errorf("expected length %d but got %d", expectedLen, actualLen)
	}
}
