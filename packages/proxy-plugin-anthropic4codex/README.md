# @jixo/proxy-plugin-anthropic4codex

Proxy plugin that enables [Codex CLI](https://github.com/openai/codex) to use Claude models by converting between OpenAI Responses API and Anthropic Messages API.

## Quick Start

### 1. Configure Proxy

Add to `proxy-config.json`:

```json
{
  "name": "codex-to-claude",
  "enabled": true,
  "target": "https://api.anthropic.com/v1/messages",
  "path": "/codex/responses",
  "headers": {
    "x-api-key": "sk-ant-xxx",
    "x-target-model": "claude-opus-4-5-20251101"
  },
  "hooks": [
    {
      "type": "http",
      "command": "bunx",
      "args": ["@jixo/proxy-plugin-anthropic4codex"]
    }
  ]
}
```

### 2. Configure Codex CLI

In `~/.codex/config.toml`:

```toml
model = "gpt-5.2"
model_provider = "claude_proxy"

[model_providers.claude_proxy]
name = "Claude via Proxy"
base_url = "http://localhost:20002/codex"
wire_api = "responses"
```

### 3. Run

```bash
# Start proxy
bun start

# Use Codex
codex "Hello, Claude!"
```

## Configuration

### Model Selection

Models are specified via `x-target-model` header in proxy config (no hardcoded mapping):

```json
{
  "headers": {
    "x-target-model": "claude-opus-4-5-20251101"
  }
}
```

### Debug Mode

```json
{
  "hooks": [
    {
      "type": "http",
      "command": "bun",
      "args": ["run", "packages/proxy-plugin-anthropic4codex/src/index.ts"],
      "env": { "DEBUG": "true" }
    }
  ]
}
```

## API Conversion

```
Codex Responses API          →    Claude Messages API
────────────────────              ──────────────────
model: "gpt-5.2"             →    model: (from x-target-model header)
instructions: "..."          →    system: [{type:"text",...}]
input: [items...]            →    messages: [{role,content}...]
reasoning: {effort:"xhigh"}  →    thinking: {budget_tokens:32768}
tools: [{type:"function"}]   →    tools: [{name,input_schema}]
```

## Tool Mappings

- Tool names are preserved (e.g. `exec_command`, `write_stdin`, `update_plan`, `mcp__*`).
- Custom tools (including `apply_patch`) are exposed to Claude as JSON input: `{ "input": "..." }` (Codex uses a freeform string input).
- Tool outputs (`function_call_output`) can be either a string or Codex content items (e.g. screenshots as `input_image`); these are converted into valid Claude `tool_result` content blocks (`text`/`image`) so upstream requests don’t fail.
- OpenAI built-in `web_search` is mapped to Anthropic server-side `web_search` (`web_search_20250305`); response-side `server_tool_use(name=web_search)` is surfaced as a Codex `web_search_call` item (no local execution), while the upstream `web_search_tool_result` is used by Claude to produce final text.
- Claude often splits final answers into many `text` blocks; the response converter merges consecutive text blocks into a single Codex `message` item so Markdown stays readable in Codex CLI.
- Prompt caching: uses 1 cache breakpoint in `system` plus up to 3 in `messages`, preferring the latest `tool_use` / `tool_result` boundaries and the latest user `text` (with fallbacks), matching Droid-like sliding cache behavior.

## Documentation

- **[Implementation Guide](./docs/implementation-guide.md)** - Complete implementation details, problems solved, and debugging tips
- **[Codex API Details](./docs/api-conversion-codex-details.md)** - Codex Responses API type definitions
- **[Claude API Details](./docs/api-conversion-claude-code-details.md)** - Claude Messages API details

## Programmatic Usage

```typescript
import { createCodexPlugin } from "@jixo/proxy-plugin-anthropic4codex";
import { definePlugin } from "@jixo/proxy-plugin";

definePlugin(createCodexPlugin({ debug: true }));
```

## License

MIT
