# Focus Strategy

A strategy: a policy for how the agentic loop runs. This one puts the model into
uninterrupted investigation — read and meta tools only, auto-approved, so it can
survey a codebase without touching a file or stopping to ask.

```bash
juggler ext link ./examples/extensions/focus-strategy
```

Then pick **Focus** from the strategy switcher (Shift+Tab).

## What a strategy actually does

It does **not** drive the loop. In a normal install the Go worker owns the loop —
call the model, execute tools, repeat. A strategy *shapes* that loop through its
manifest and a handful of hooks the worker calls:

| Hook | Used here for |
|------|---------------|
| `filterTools(tools)` | Drop every `write` tool, so the model is never even offered one |
| `getApprovalPolicy(info)` | Auto-approve what's left, so nothing parks for a human |
| `onActivate(previousId)` | Announce the mode with `injectGuidance()` |

## The two things worth stealing

**Steer with `injectGuidance()`, never by writing system-prompt text.** It
appends a durable system-reminder to the conversation, which reaches the model on
the production worker path *and* leaves the cached system prefix untouched. A
strategy that rewrote the system prompt would bust the prompt cache on every
switch.

**`getApprovalPolicy` must return `DEFAULT` in two cases**, or it silently
answers for the user:

- **Elicitations** (`interactionKind === 'elicitation'`) — tools like
  `AskUserQuestion` where the "approval" *is* the user's answer. Approving one
  runs it with no answer.
- **Non-auto-approvable checkpoints** (`autoApprovable === false`) — calls the
  tool itself marks as a deliberate human review point.

Note that `AskUserQuestion` is category `read`, so a naive "auto-approve all
reads" policy catches it. The guard below is not hypothetical.
