# @jixo/proxy-plugin-anthropic4codex - Development Guide

## Overview

This plugin converts Codex Responses API ↔ Claude Messages API, enabling Codex CLI to use Claude models.

## Architecture

```
Codex CLI
    ↓ Responses API
proxy-plugin-anthropic4codex
    ├── request-converter.ts   (Codex → Claude)
    ├── response-converter.ts  (Claude SSE → Codex SSE)
    ├── constants.ts           (Headers/budgets/ids)
    └── plugin.ts              (Hook entry)
    ↓ Messages API
Claude API
```

## Key Files

| File | Purpose |
|------|---------|
| `src/request-converter.ts` | Request transformation |
| `src/response-converter.ts` | SSE stream conversion |
| `src/constants.ts` | Shared constants |
| `src/types.ts` | Type definitions |
| `src/plugin.ts` | Plugin hooks |

## Development

```bash
# Type check
bun ts

# Run in dev mode
bun run packages/proxy-plugin-anthropic4codex/src/index.ts
```

## Key Implementation Notes

1. **Model Selection**: Via `x-target-model` header (no hardcoded mapping)

2. **Signature Handling**: Claude sends `signature` via `signature_delta` event (not in `content_block_start`). Must accumulate and save to `encrypted_content`.

3. **Tool Parameters**: Codex may use `cmd` or `command` for Bash commands - check both.

4. **Reasoning without Signature**: Convert to `[Reasoning: ...]` text block (Claude rejects empty signatures).

5. **Headers**: Must include Claude Code identity headers (`user-agent`, `x-stainless-*`, etc.)

## Documentation

See **[docs/implementation-guide.md](./docs/implementation-guide.md)** for:
- Complete conversion rules
- Problems encountered and solutions
- Debugging techniques
- Full type definitions
