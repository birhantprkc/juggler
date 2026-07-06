
### Why I’m building Juggler

I’ve spent 30 years as a C++ developer, mostly in the audio space—working on everything from high-level UIs to gritty realtime code. My niche has been building tools and libraries for other devs. Almost everything I’ve ever released started because I was irritated by my existing tools and decided I could do better.

Lately, I've been using AI coding agents, and they’ve given me a familiar itch.

While the rest of the industry seems to be rushing toward "autonomous agents" and complex multi-LLM systems, that stuff leaves me cold. I don't want a black box doing the work for me; I want a more hands-on tool for driving the models myself.

I’m sold on the fact that today’s models can write great code faster than I can. But I still want to control the process.

For me, the CLI is the first big friction point - to me, a CLI seems like a terrible interface for this. I know lots of people love their terminal-based agents, so this is not for them, but I think that if your work consists of typing long chunks of English, reading markdown docs, and navigating complicated tool results, you need a real UI.

Context should be a document, not a log.
When you're writing a program, that's your context. I want Juggler to treat that context as a living document. I want to be able to go back, edit bits, re-use them, and use undo/redo. If the LLM goes off-piste, I don't want to waste more context "discussing" it — I want to just delete it like a typo and try a different approach.

The "Stack" vs. the "Heap."
Context windows are finite. Instead of using the window as a "heap" where we just pile things up until it overflows, we should treat it like a stack. Juggler isn't just a flat conversation; it’s a tree of threads. The UI is designed specifically to let you visualize and navigate these sub-tasks without losing your place.

Also: sub-tasks.. A context window has a finite size, so rather than using it as a heap, we should be using it like a stack. So Juggler's model is not just a conversation, it's a *tree* of conversations, where the whole UX is designed for visualising and navigating these sub-conversations ("threads").

I’m building Juggler because I'm trying to create the tool I want for my own daily work. If it sounds like something you’d find useful too, that’s great.
