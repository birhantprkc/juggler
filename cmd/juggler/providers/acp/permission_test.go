//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import "testing"

func TestDefaultApprover(t *testing.T) {
	tests := []struct {
		name         string
		options      []permissionOption
		wantSelected bool
		wantOptionID string
	}{
		{
			name: "prefers allow_once",
			options: []permissionOption{
				{OptionID: "always", Kind: kindAllowAlways},
				{OptionID: "once", Kind: kindAllowOnce},
				{OptionID: "no", Kind: "reject_once"},
			},
			wantSelected: true,
			wantOptionID: "once",
		},
		{
			name: "falls back to allow_always",
			options: []permissionOption{
				{OptionID: "no", Kind: "reject_once"},
				{OptionID: "always", Kind: kindAllowAlways},
			},
			wantSelected: true,
			wantOptionID: "always",
		},
		{
			name: "falls back to first non-reject",
			options: []permissionOption{
				{OptionID: "custom", Kind: "custom_kind"},
				{OptionID: "no", Kind: "reject_always"},
			},
			wantSelected: true,
			wantOptionID: "custom",
		},
		{
			name:         "no options declines",
			options:      nil,
			wantSelected: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			out := defaultApprover{}.Approve(PermissionRequest{Options: tc.options})
			if out.Selected != tc.wantSelected {
				t.Fatalf("selected = %v, want %v", out.Selected, tc.wantSelected)
			}
			if tc.wantSelected && out.OptionID != tc.wantOptionID {
				t.Fatalf("optionID = %q, want %q", out.OptionID, tc.wantOptionID)
			}
		})
	}
}
