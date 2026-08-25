# Hello Tool

The smallest useful extension: one context item, which is a tool the model can
call. It counts the words in a string — no filesystem, no network, no approval,
so there is nothing in the way of the shape you actually came to read.

```bash
juggler ext link ./examples/extensions/hello-tool
```

Then ask the model to count the words in something.

## What to look at

`context-items/word-count-context-item.js`, in the order the framework calls it:

| Member | Job |
|--------|-----|
| `static MANIFEST` | Identifies the capability. Required: `id`, `name`, `version`, `description`. |
| `static getToolDefinitions()` | The schema the **model** sees. One class may expose several tools. |
| `validate(toolInput)` | Reject bad input before anything runs, with a message the model can act on. |
| `execute(params)` | Do the work. Returns **raw** data. |
| `getSummary(outcome)` | Turn the outcome into the one line shown in the transcript. |

## The one trap

`execute()` returns raw data, and the framework wraps it as an outcome:

```javascript
{ success: true, result: <what execute returned>, prepared: …, error: … }
```

So in `getSummary()` you read `outcome.result.count`, **not** `outcome.count`.
Reading the latter yields `undefined`, and the model sees an empty result with no
error to explain it. This is the most common mistake in a first extension.
