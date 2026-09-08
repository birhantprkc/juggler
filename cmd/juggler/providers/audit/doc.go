//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package audit holds the cross-provider checks on the model catalogs — the
// per-model context windows and output caps every provider publishes.
//
// It carries no production code, and deliberately so: the checks need to see
// every provider at once, which no single provider package can do without
// importing its siblings. Registering them all in one place is also what lets
// a new provider be covered the moment it is added to the registration list
// here, rather than needing a copy of each check written into its own package.
//
// Two kinds of check live here:
//
//   - The invariants (catalog_test.go) — no network, part of every run. They
//     say what a catalog entry must satisfy to be usable at all, chiefly that
//     an output cap must leave room for input.
//   - The drift audit (live_audit_test.go) — opt-in, one network round-trip
//     per credentialed provider. It compares what we publish against what the
//     provider currently serves, which is the only way to catch a catalog that
//     has quietly gone stale.
package audit
