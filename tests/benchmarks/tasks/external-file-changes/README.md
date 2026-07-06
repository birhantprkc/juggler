# External File Change Detection - Test Suite

## Summary

Comprehensive test suite for detecting and handling external file modifications during LLM turns.

## The Problem

Files can be modified externally (by user, other processes, git operations) while the LLM is working. Without detection:
1. LLM reads file → creates context item with hash
2. File changes externally
3. LLM tries to edit using stale context
4. Edit fails or corrupts file

## The Solution

**Simple, robust approach:**
- Store file hash with each read-file context item
- Before executing actions, check if ANY file in context changed (parallel hash checks)
- If ANY file changed → Retry entire LLM turn with fresh context
- No partial updates, no complex tracking

## Test Coverage

### ✅ Basic Scenarios (2 tests)
- File modified externally → Detects → Retries → Succeeds
- No external changes → Proceeds normally → No retry

### ✅ Multiple Files (1 test)
- Two files in context, one modified → Detects → Retries entire turn

### ✅ Edge Cases (4 tests)
- File deleted externally
- Empty file becomes non-empty
- Unicode/emoji content
- Permission errors during hash check

### ✅ Performance (1 test)
- Large file (10KB) → Hash check remains efficient

## Test Files

```
tests/benchmarks/tasks/external-file-changes/
├── test-external-basic.json              # Basic external modification
├── test-external-no-changes.json         # Control (no modification)
├── test-external-multiple-files.json     # Multiple files in context
├── test-external-deleted-file.json       # File deletion
├── test-external-empty-file.json         # Empty → non-empty
├── test-external-non-ascii.json          # Unicode handling
├── test-external-permission-error.json   # Permission errors
├── TEST_PLAN.md                          # Detailed test strategy
└── README.md                             # This file

tests/benchmarks/fixtures/external-change-fixture/
└── src/
    ├── config.js        # Basic test file
    ├── utils.js         # Multiple files test
    ├── temp.js          # Deletion test
    ├── empty.js         # Empty file test
    ├── unicode.js       # Unicode test
    ├── restricted.js    # Permission test
    └── large.js         # Performance test (10KB)
```

## Running Tests

```bash
# Run all external change tests
make benchmark ARGS="--category external-file-changes"

# Run specific test
make benchmark ARGS="--task test-external-basic"

# Run with verbose output
make benchmark ARGS="--category external-file-changes --verbose"
```

## Expected Behavior

### When External Change Detected:
1. Pre-flight check detects hash mismatch
2. Status message: "🔄 Files were modified externally. Retrying..."
3. Iteration counter increments
4. Fresh context built (all context items re-read with new hashes)
5. LLM receives fresh context
6. Actions re-executed successfully

### When No Changes:
1. Pre-flight check passes (all hashes match)
2. No retry message
3. Actions execute normally
4. No iteration penalty

## Implementation Status

### ⏳ TODO
- Test infrastructure for simulating external modifications
- Running tests to validate implementation
- Fixing edge cases discovered by tests
- Performance optimization if needed

## TDD Workflow

1. ✅ **Write tests** - Define all scenarios
2. ⏳ **Implement test infra** - External modification simulator
3. ⏳ **Run tests** - Watch them fail (or pass!)
4. ⏳ **Fix issues** - Make tests pass
5. ⏳ **Refactor** - Optimize and clean up

## Success Criteria

- ✅ All 7 tests pass
- ✅ No false positives (unnecessary retries)
- ✅ No false negatives (missed external changes)
- ✅ Graceful error handling
- ✅ Performance within limits (< 50ms hash checks)
- ✅ Clear user feedback (status messages)
