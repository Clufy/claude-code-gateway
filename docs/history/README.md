# Design history

The specs and implementation plans the proxy was built from, kept for the reasoning behind
decisions. They describe the code **as it was planned at the time**: file paths and names in
them predate later refactors (for example the 2026-11-14 move of `src/*.ts` into folders).
For how the code works today, read [ARCHITECTURE.md](../ARCHITECTURE.md).

## Specs

| Date       | Spec                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| 2026-08-27 | [Claude Worker Proxy enhancement](specs/2026-08-27-claude-worker-proxy-enhancement-design.md)    |
| 2026-11-07 | [Security workflows roadmap (phases 1–7)](specs/2026-11-07-security-workflows-roadmap-design.md) |
| 2026-11-14 | [Phase 8: model-agnostic proxy](specs/2026-11-14-model-agnostic-design.md)                       |

## Plans

| Date       | Plan                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| 2026-08-27 | [Enhancement](plans/2026-08-27-claude-worker-proxy-enhancement.md)                               |
| 2026-11-08 | [Phase 1: foundation and hardening](plans/2026-11-08-phase1-foundation-hardening.md)             |
| 2026-11-08 | [Phase 2: routing, reliability, qualify](plans/2026-11-08-phase2-routing-reliability-qualify.md) |
| 2026-11-12 | [Phase 3: engagements and modes](plans/2026-11-12-phase3-engagements-modes.md)                   |
| 2026-11-13 | [Phase 4: session guard and scope hook](plans/2026-11-13-phase4-guard-hook.md)                   |
| 2026-11-13 | [Phase 5: MCP server](plans/2026-11-13-phase5-mcp-server.md)                                     |
| 2026-11-13 | [Phase 6: red-team harness](plans/2026-11-13-phase6-redteam-harness.md)                          |
| 2026-11-13 | [Phase 7: purple loop](plans/2026-11-13-phase7-purple-loop.md)                                   |
| 2026-11-14 | [Phase 8: model-agnostic proxy](plans/2026-11-14-phase8-model-agnostic.md)                       |
