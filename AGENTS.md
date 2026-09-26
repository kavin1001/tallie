# Project continuity

- Start with `docs/README.md` and `docs/technical/implementation-tracker.md`; read the PRD and technical-design sections relevant to the current task.
- After meaningful implementation milestones, update the tracker with completed changes, test evidence, unresolved issues, and the next concrete action. Record material design changes in the technical design and decision log.
- Before an explicit handoff or manual compaction, save current work state in those files so the next session can continue without depending on the transcript. Do not assume automatic compaction provides a pre-compaction editing opportunity.
- Keep verification labels accurate: public documentation, local design tests, implementation tests, sandbox behavior, and live behavior are different evidence levels.
- Never store API keys, customer receipts, or identity documents in continuity notes.

## Compaction preference

The user requested automatic compaction at 60% context usage. The native setting in `~/.codex/config.toml` is `model_auto_compact_token_limit = 155040` with scope `total`, calculated from this session's observed 258,400-token usable window. The runtime setting controls automatic compaction; this instruction file does not trigger it. If the model/context window changes, verify the new effective window and recalculate the token threshold before claiming it still represents 60%.
