<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:claude-to-codex-compat -->
# Claude Code → Codex compatibility

- Treat `.agents/skills/` as the authoritative Codex skill directory. `.claude/skills/` is legacy source material; do not follow it when an `.agents` counterpart exists.
- Resolve legacy `[[memory-name]]` references against `D:\fashuo\Claude记忆备份\memory-name.md`. Read the referenced file when the rule is relevant; never assume its contents from the link name alone.
- Interpret legacy tool words such as `Read`, `Grep`, `Glob`, `Bash`, and `PowerShell` as required actions, not literal tool names. Use the available Codex filesystem/search/shell tools; prefer `rg` for text and file search.
- Interpret `Opus` / `Sonnet` / `Haiku` in migrated rules as historical quality or cost tiers, not as an instruction to impersonate Claude or call a particular provider. On the PC path, use the current Codex model with full available reasoning and preserve the rule's intended rigor.
- Persist learning state only through the repository's declared ledgers, scripts, Supabase tables, and backup flow. Do not rely on chat-only memory for facts that must survive sessions.
- Preserve Beijing-date semantics for study records even when the host or session timezone differs; use the project scripts' date handling unless a task explicitly requires another timezone.
- Treat `D:\fashuo` as the separate content/archive repository. Its `CLAUDE.md` is legacy background, while this repository's `.agents/skills/`, live `.local` ledgers, and Supabase data are the current operational truth. Do not edit or commit the archive merely because it was read as evidence.
- Never print `.env` values, PM2 environment objects, service-role tokens, API keys, passwords, or notification secrets during diagnostics; select only the non-secret fields needed for the check.
<!-- END:claude-to-codex-compat -->
