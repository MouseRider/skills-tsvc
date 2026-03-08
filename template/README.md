# TSVC Template — Adapt to Your Agent Framework

This directory contains a framework-agnostic template for implementing TSVC. Copy these files, implement the adapter functions for your specific framework, and you're running.

## Files

- `tsvc-adapter.py` — The adapter interface. Implement the 5 functions marked `# IMPLEMENT` for your framework.
- `tsvc-core.py` — Core TSVC logic. Works out of the box — no modifications needed.
- `context-template.md` — Template for new topic context files.

## Quick Start

1. Copy this directory into your project
2. Edit `tsvc-adapter.py` — implement the framework-specific functions
3. Call `tsvc-core.py` operations from your agent's message handling loop
4. Add the boot hook to your agent's startup sequence

See the [Integration Guide](../docs/integration.md) for framework-specific notes.
