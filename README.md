# DiffLoupe

AI-powered diff understanding and review tool.

## Overview

DiffLoupe helps developers understand code changes by providing intelligent analysis of git diffs, highlighting important modifications, and explaining the purpose and impact of changes.

## Development

```bash
# Install dependencies
bun install

# Run in dev mode (with watch)
bun run dev

# Type check
bun run typecheck

# Build
bun run build
```

## Project Structure

```
src/
  index.ts          # Entry point
  cli/              # CLI commands
  services/         # Git, LLM, cache services
  prompts/          # LLM prompt templates
  types/            # TypeScript types
```
