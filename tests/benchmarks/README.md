# Juggler AI Coding Benchmarks

Automated testing framework for evaluating Juggler's AI coding capabilities.

## Overview

The benchmark framework tests Juggler through its **actual frontend APIs** - the same way users interact with it. Each test creates its own isolated session and sandbox directory, ensuring authentic end-to-end testing.

## Quick Start

### Prerequisites

**API Key Configuration**: The benchmark runner uses the same credential store as the main Juggler app.

1. **Via Juggler UI** (Recommended):
   - Run `./bin/juggler`
   - Go to Settings → Credentials
   - Add your API keys
   - Keys are saved to `~/.juggler/credentials.json`

2. **Via Environment Variables** (Alternative):
   ```bash
   export Z_AI_API_KEY=your-key-here
   export ANTHROPIC_API_KEY=your-key-here
   export GEMINI_API_KEY=your-key-here
   ```

**Note**: The credentials file takes precedence over environment variables. If you have both configured, the credentials file will be used.

### Option 1: Headless Runner (Recommended for CI/CD)

```bash
# Build and run benchmarks in headless Chrome
make benchmark

# Or run directly with custom timeout
./bin/run-benchmarks --timeout=30  # 30 minute timeout
```

The headless runner:
- Starts Juggler server automatically
- Loads API keys from `~/.juggler/credentials.json` or environment variables
- Runs tests in headless Chrome
- Displays live progress with colored output
- Generates summary table with pass/fail status
- Saves results to `tests/benchmarks/results/results.json`

### Option 2: Interactive Browser Testing

1. **Start Juggler**:
   ```bash
   ./bin/juggler
   ```

2. **Navigate to test runner**:
   ```
   http://localhost:3939/test
   ```

3. **Click "Run All Tests"**

This option lets you watch tests run in real-time with full UI visibility.

## How It Works

### Architecture

```
Headless Chrome (via chromedp) OR Interactive Browser
    ↓
/headless-test OR /test (auto-starts test orchestrator)
    ↓
TestOrchestrator (coordinates test execution)
    ↓
TestExecutor (runs each task)
    ↓
Real Juggler APIs:
    - Session API (create sessions)
    - Plugin API (read files, execute commands)
    - WebSocket API (send messages, get responses)
    - Fixture API (setup/cleanup temp directories)
    ↓
TestScorer (evaluates results)
    ↓
Results displayed in real-time / saved to JSON
```

### CLI Options (Headless Runner)

```bash
./bin/run-benchmarks [options]

Options:
  --task=TASK_ID          Run specific task (e.g., ci-tree, action-edit-from-ci)
  --category=CATEGORY     Run all tasks in category (e.g., context-items, actions, errors, swe-bench)
  --port=PORT             Server port (default: 3939)
  --timeout=MINUTES       Overall timeout in minutes (default: 30)
  --results-file=PATH     Output JSON file (default: tests/benchmarks/results/results.json)
  --provider=PROVIDER     Specify LLM provider (anthropic, gemini, zai)
  --debug                 Enable debug mode
```

### Examples

```bash
# Run all context item tests
make benchmark ARGS="--category=context-items"

# Run specific test
make benchmark ARGS="--task=ci-tree"

# Run all action tests
make benchmark ARGS="--category=actions"

# Run strategy tests
make benchmark ARGS="--category=strategies"

# Run SWE-bench tests only
make benchmark ARGS="--category=swe-bench"

# Run all tests (37 total across 7 categories)
make benchmark
```

### What Gets Tested

✅ **Real Juggler workflow**:
- Session creation via API
- Context item creation and management
- Context assembly from context items
- WebSocket message sending
- LLM response handling
- Action execution

❌ **NOT tested** (because users can't access them):
- Direct agent calls
- Internal implementation details
- Bypassing the frontend

## Test Categories

### Context Item Tests (6 tasks)
Comprehensive testing of individual context item capabilities:

- **ci-tree**: Tree generation with depth, glob filtering, file-type filtering, large directory handling
- **ci-read-file**: All read modes (full, lineRange, tail, head, around), large file truncation
- **ci-grep**: Regex patterns, case sensitivity, file filtering, context lines, no-match handling
- **ci-python**: Python execution, stdout/stderr capture, timeout behavior, error handling
- **ci-rule**: Built-in and custom context rules
- **ci-interaction**: Multi-context-item workflows (tree→read, grep→read, complex analysis)

### Action Tests (4 tasks)
Testing all editing and execution actions with edge cases:

- **action-write-file**: Create new files, overwrite existing files, diff previews
- **action-replace-text**: Search-replace editing with exact matching and whitespace sensitivity
- **action-edit-from-ci**: Context-item-based editing workflow (read file as context item, then edit)
- **action-execute**: Shell command execution, test suites, output capture

### Error Handling Tests (2 tasks)
Testing error scenarios and recovery strategies:

- **error-validation**: Invalid inputs, line numbers out of range, validation failures
- **error-filesystem**: Empty files, special characters, nested directories, overwrite behavior

### Strategy Tests (3 tasks)
Testing different agent strategies:

- **strategy-default**: Standard read-modify-write workflow
- **strategy-research**: Read-only exploration mode (verifies write blocking)
- **strategy-plan**: Plan-then-execute workflow with plan approval

### External File Change Tests (8 tasks)
Testing detection of files modified externally during LLM turns:

- **test-external-basic**: File modified externally, system detects and retries
- **test-external-no-changes**: Control test, no external changes
- **test-external-multiple-files**: Multiple files in context, one changed
- **test-external-deleted-file**: File deleted externally
- **test-external-empty-file**: Empty file gets content externally
- **test-external-large-file**: Large file modification detection
- **test-external-non-ascii**: Unicode/emoji content handling
- **test-external-permission-error**: Permission changes detection

### Integration Tests (1 task)
Runs the complete JS integration test suite:

- **all-integration-tests**: Executes all 95+ integration tests with mock LLM

### SWE-bench Tests (10 tasks)
Real-world GitHub issues from open-source projects:

- Flask, Requests, Pytest, Sphinx issues
- Git-based fixtures cloned from actual repositories
- Tests against production codebases

## Directory Structure

### Test Project Structure

```
benchmarks/
├── README.md                      # This file
├── fixtures/                      # Test projects (minimal, focused)
│   ├── ci-tree-fixture/          # Nested directories for tree testing
│   ├── ci-read-fixture/          # Files with different read modes
│   ├── ci-grep-fixture/          # Code with searchable patterns
│   ├── ci-python-fixture/        # Python scripts for execution
│   ├── action-edit-fixture/      # Files for testing edit actions
│   ├── error-handling-fixture/   # Edge cases and error scenarios
│   └── external-change-fixture/  # Files for external modification tests
├── tasks/                         # Task definitions (JSON)
│   ├── context-items/            # Context item capability tests (6)
│   ├── actions/                  # Action reliability tests (5)
│   ├── errors/                   # Error handling tests (4)
│   ├── strategies/               # Strategy behavior tests (3)
│   ├── external-file-changes/    # External modification tests (8)
│   ├── integration-tests/        # JS integration test runner (1)
│   └── swe-bench/                # Real GitHub issues (10)
└── results/                       # Test results (gitignored)
```

### Test Execution Directory Structure

When tests run, each test creates an isolated directory in `/tmp/juggler/`:

```
/tmp/juggler/
└── 20251107-152004-task-bugfix-001/    # Date-stamped results directory
    ├── log.txt                          # Complete test execution log
    └── fixture/                         # Isolated fixture working directory
        ├── .juggler/                    # Session data
        ├── src/                         # Source files
        ├── tests/                       # Test files
        └── ...                          # Other fixture files
```

**Key features:**
- **Single directory per test**: All test artifacts in one place
- **Date-stamped names**: Easy to identify and sort test runs
- **Isolated fixtures**: Each test gets its own copy of fixture files
- **Complete logs**: Full test execution output captured in `log.txt`
- **Auto-cleanup**: Test directories are removed after test completes (unless debug mode)

This structure ensures:
- No interference between concurrent tests
- Easy debugging (all test data in one location)
- Clean organization (log + fixture together)
- Reproducible test environments

## Task Definition Format

Each task is a JSON file:

```json
{
  "id": "bugfix-001",
  "category": "simple-bug-fixes",
  "description": "Fix the off-by-one error",
  "fixture": "python-simple",
  "prompt": "Fix the bug in range_sum function...",
  "strategy": "default",
  "scoring": {
    "type": "test_pass",
    "test_command": "python tests/test_math_utils.py",
    "timeout": 10
  },
  "metadata": {
    "difficulty": "easy",
    "expected_files_changed": ["src/math_utils.py"],
    "tags": ["python", "bug-fix"]
  }
}
```

### Optional Fields

- **strategy**: Specifies which strategy to use (default, research, plan, execute). If not specified, uses "default".

## Scoring Types

### file_contains
Checks if file contains required strings:
```json
{
  "type": "file_contains",
  "file_path": "src/utils.py",
  "contains_strings": ["import logging", "logger.info"]
}
```

### test_pass
Runs tests and checks if they pass:
```json
{
  "type": "test_pass",
  "test_command": "python -m pytest tests/",
  "timeout": 60
}
```

### multi_file_consistency
Checks multiple files for expected content:
```json
{
  "type": "multi_file_consistency",
  "files": [
    {
      "path": "src/validation.js",
      "contains_strings": ["validateEmail", "module.exports"]
    },
    {
      "path": "src/utils.js",
      "not_contains": ["function validateEmail"]
    }
  ]
}
```

## Metrics Tracked

**Per Task:**
- Score (0.0 - 1.0)
- Passed (≥80% score)
- Duration (seconds)
- Files changed
- Details/error messages

**Aggregate:**
- Overall score
- Pass rate
- Average duration
- Score by category

## Results

Results are displayed in the browser and saved to `results/`:
- Real-time progress bar
- Live results table
- Summary statistics
- Category breakdown

## Adding New Tests

### Context Item Tests
Add tests for new context item capabilities in `tasks/context-items/`:

1. Create minimal fixture (3-10 files) in `fixtures/ci-name-fixture/`
2. Create `tasks/context-items/ci-name.json` with comprehensive prompt
3. Test should exercise ALL capabilities of the context item
4. Use appropriate scoring (usually `file_contains` for results document)

### Action Tests
Add tests for new actions or editing scenarios in `tasks/actions/`:

1. Reuse existing fixtures or create minimal new one
2. Create `tasks/actions/action-name.json`
3. Test should demonstrate action reliability and edge cases
4. Use `file_contains` or `multi_file_consistency` scoring

### Error Handling Tests
Add tests for new error scenarios in `tasks/errors/`:

1. Create fixture that triggers specific error conditions
2. Create `tasks/errors/error-name.json`
3. Test should verify graceful error handling and recovery
4. Document error messages and recovery strategies

### Strategy Tests
Add tests for strategy behaviors in `tasks/strategies/`:

1. Create `tasks/strategies/strategy-name.json`
2. Set the `"strategy"` field to the strategy being tested
3. Design prompts that exercise strategy-specific behaviors:
   - **research**: Verify read-only mode blocks writes
   - **plan**: Verify plan creation and approval flow
   - **default**: Verify standard read-modify-write workflow
4. Use scoring that validates the strategy's expected outcome

### Testing Your New Test

```bash
# Run specific test
make benchmark ARGS="--task=your-test-id"

# Run category
make benchmark ARGS="--category=context-items"
```

## Why Frontend-Based Testing?

**Authentic Testing:**
- Tests the REAL system users interact with
- No shortcuts or bypasses
- Full integration testing via actual APIs

**Dual Mode Support:**
- **Headless**: Fast automated testing for CI/CD pipelines
- **Interactive**: Visual debugging and test development

**Visibility (Interactive Mode):**
- Watch tests run in real-time
- See context items being created
- Observe message flow
- Debug easily

**Correct Architecture:**
- Frontend owns context assembly and context item management
- Backend is storage + LLM passthrough + native operations
- Tests respect the actual frontend-driven architecture

## Troubleshooting

**No API key configured:**
- Error message: "No API key configured for provider..."
- Solution: Add API keys via Juggler UI (Settings → Credentials) or set environment variables
- The test runner loads keys from `~/.juggler/credentials.json`
- If the file exists but keys are missing, add them through the Juggler UI

**Tests not loading:**
- Check `/api/test/tasks` returns task list
- Verify JSON files are valid

**Tests timing out:**
- Check LLM provider is configured
- Verify API keys are set (see "No API key configured" above)
- Look at browser console for errors

**Tests failing unexpectedly:**
- Check fixture files exist
- Verify scoring criteria are correct
- Review browser console logs
- For SWE-bench tests, check if git repos cloned correctly in `/tmp/juggler/`

## Future Enhancements

- [x] Headless testing with chromedp
- [ ] CI/CD integration (GitHub Actions, etc.)
- [ ] Historical results tracking
- [ ] Performance benchmarking (execution time, token usage)
- [ ] More sophisticated scoring algorithms
- [ ] Test result comparison across runs
- [ ] Parallel test execution

## Philosophy

From CLAUDE.md:
> ❌ **NO MOCKS**: All tests use real providers with real API keys
> ✅ Integration tests only - test against actual APIs

The benchmarks follow this principle - they test the real Juggler system using real APIs, not mock implementations.

