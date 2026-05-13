---
name: plannotator-annotate
description: Open Plannotator's annotation UI for a markdown file, converted HTML file, URL, or folder and then respond to the returned annotations.
---

# Plannotator Annotate

Use this skill when the user wants to annotate a document in Plannotator instead of reviewing it inline in chat.

Run:

```bash
plannotator annotate <path-or-url>
```

Inside an OMP (Oh My Pi) session, the `<path-or-url>` argument also accepts OMP internal URIs that resolve session-aware:

- `local://<file>` — session scratch (e.g. `local://PLAN.md`).
- `skill://<name>[/<file>]` — a discovered skill's SKILL.md or a file inside its directory.
- `agent://<id>` — agent output for a completed subagent task.
- `artifact://<id>` — a recorded artifact in the current session.
- `rule://<name>`, `memory://<name>` — global agent rules and memory.

Behavior:

1. Launch the command with Bash.
2. Wait for the browser review to finish.
3. If annotations are returned, address them directly.
4. If the session closes without feedback, say so briefly and continue.

Do not ask the user to paste a shell command into the chat. Run the command yourself.
