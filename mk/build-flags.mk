# ─────────────────────────────────────────────────────────────────────────────
# build-flags.mk — single source of truth for how any juggler binary compiles.
#
# Included by this repo's own Makefile (`include mk/build-flags.mk`). It is also
# included, unmodified, by the private release/packaging build that layers extra
# server features on top of this module — so the two builds can never drift on
# ldflags, cgo flags, or the macOS deployment target. This fragment ships in the
# public repo and the public build uses it standalone; it knows nothing about
# any outer module.
#
# The including Makefile MUST define, before the include:
#   UNAME_S    := $(shell uname -s)
#   VERSION    — release version string (e.g. read from the VERSION file)
#   COMMIT     — short git SHA
#   BUILD_DATE — RFC3339 UTC timestamp
# These are sourced differently per repo (a nested submodule reads its own
# VERSION file / git dir), so they stay local; only their *use* is shared here.
# ─────────────────────────────────────────────────────────────────────────────

GOCMD ?= go
# Default builds are test-capable: cmd/juggler/testing/ and worker test-support
# are gated by `//go:build !production`, so omitting the tag keeps them in the
# binary. GOBUILD_RELEASE adds -tags production to exclude them from shipped
# binaries.
GOBUILD = $(GOCMD) build
GOBUILD_RELEASE = $(GOCMD) build -tags production

# Pin the macOS deployment target so clang compiles Wails v3's Objective-C .m
# files and the Go linker agree on a min OS version. Without this clang defaults
# to the host SDK (macOS 26 on recent Macs) while the Go linker defaults to
# 11.0, producing "object file was built for newer macOS" warnings on every
# build. 14.0 = Sonoma, our minimum supported macOS.
MACOSX_DEPLOYMENT_TARGET ?= 14.0
export MACOSX_DEPLOYMENT_TARGET
# MACOSX_DEPLOYMENT_TARGET alone doesn't silence the warning for the cgo
# runtime-support objects (runtime/cgo's _x_cgo_thread_start &c.): they're
# clang-compiled but cached, and the deployment-target env is NOT part of Go's
# build-cache key, so a stale 26.0 object gets reused. Putting the min-version
# on CGO_CFLAGS bakes it into the compile command line, which IS hashed into the
# cache key, so those objects rebuild at 14.0 too. CGO_LDFLAGS covers the *link*
# step for `go test` commands that don't carry explicit -ldflags: Go passes its
# hardcoded 11.0 platform version to clang, but CGO_LDFLAGS is appended after it,
# so -mmacosx-version-min=14.0 wins. Darwin-only: these flags are clang errors on
# Linux/Windows toolchains (Windows builds are CGO_ENABLED=0).
ifeq ($(UNAME_S),Darwin)
export CGO_CFLAGS=-mmacosx-version-min=$(MACOSX_DEPLOYMENT_TARGET)
export CGO_LDFLAGS=-mmacosx-version-min=$(MACOSX_DEPLOYMENT_TARGET)
endif

# Version stamps. LDFLAGS_BASE is platform-neutral (reused by the Windows/Linux
# cross-builds); LDFLAGS adds the macOS host-specific linker args.
LDFLAGS_BASE := -X juggler/cmd/juggler/core.Version=$(VERSION)
LDFLAGS_BASE += -X juggler/cmd/juggler/core.Commit=$(COMMIT)
LDFLAGS_BASE += -X juggler/cmd/juggler/core.BuildDate=$(BUILD_DATE)
LDFLAGS := $(LDFLAGS_BASE)
# Match the macOS deployment target between Go's external linker and the Wails
# v3 cgo .o files. -no_warn_duplicate_libraries: clang's runtime + Wails's
# frameworks both pull in -lobjc; macOS 26's ld warns instead of dedup'ing.
ifeq ($(UNAME_S),Darwin)
LDFLAGS += '-extldflags=-mmacosx-version-min=$(MACOSX_DEPLOYMENT_TARGET) -Wl,-no_warn_duplicate_libraries'
endif
