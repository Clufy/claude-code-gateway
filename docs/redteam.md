# Red-team harness

A canary-based harness that attacks LLM endpoints with a fixed corpus and scores the replies. Use
it only for authorized testing: against this Worker (`self:`), or against an external model
endpoint that an engagement lists in scope. Every case is canary-based: canaries look like
`CANARY-<id>`, canary hosts end in `.invalid`, and the corpus holds no real secrets, real hosts or
harmful payloads. The corpus is 70 cases: 7 suites of 10 (`direct-injection`,
`indirect-injection`, `system-prompt-leakage`, `sensitive-info`, `output-handling`,
`excessive-agency`, `agent-session`) in `redteam/corpus/<suite>/cases.json`.

The CLI reads the engagement from this Worker's `/mcp` (`engagement get`), so the Worker must be
reachable and `PROXY_KEY` must be set (`--key`, an `x-api-key` in `ANTHROPIC_CUSTOM_HEADERS`, or
`PROXY_KEY`). `--base` defaults to `ANTHROPIC_BASE_URL`.

```bash
export ANTHROPIC_BASE_URL=https://<your-worker>.workers.dev
export PROXY_KEY=<PROXY_KEY>

# One model behind this Worker, one suite
npm run redteam -- --target self:@cf/meta/llama-3.1-8b-instruct --suite agent-session

# Every model in /v1/models (side-by-side table)
npm run redteam -- --target self:all

# An external OpenAI-compatible endpoint. Credentials come from your environment, never the corpus.
export TARGET_KEY="Bearer <target-api-key>"
npm run redteam -- --target openai:https://llm.<client-host>/v1/chat/completions \
  --engagement <engagement> --model <model> --header-env "Authorization=TARGET_KEY"

# A generic HTTP API: {{prompt}} is the last attacker turn (JSON-escaped), {{history}} the turns
npm run redteam -- --target http:https://llm.<client-host>/chat --engagement <engagement> \
  --template '{"message":{{prompt}},"history":{{history}}}' --reply-path 'choices[0].message.content'
```

Targets are `self:<model>`, `self:all`, or `anthropic|openai|http:<url>`. `--reply-path` is a dotted
path with `[n]` indexes, not full JSONPath. `--header-env` is a comma list of `Header-Name=ENV_VAR`;
the header value is the variable's whole value. If the target echoes a header value of 8 or more
characters back (shorter values are left alone so they cannot mangle canaries into false passes),
it is replaced with `[redacted]` in the reply text and tool-call arguments before scoring, examples
and the judge, so it never reaches the output files.

## Authorization rules

- `self:` targets skip the engagement gate, but redirects must stay on the base origin.
- External targets need `--engagement`. The gate runs before the first request, on every redirect
  hop (at most 5), and again before every case. Only the initial refusal, before any request, exits
  with code 2 and the reason; there is no `--force`. A refused redirect hop is an error for that
  case, and a window that closes mid-run stops the run, which still exits with code 0.
- The URL must be `https` (`http` only for loopback), without userinfo. It must match an
  `llmTargets` entry, or its host must match `scope.domains`, the same rules as the scope check.
  A URL entry matches on scheme, host, effective port and path prefix:
  `https://gw.<host>/tenant-a/v1` allows `/tenant-a/v1` and `/tenant-a/v1/chat`, but not
  `/tenant-a/v10`, `/tenant-b/v1`, port `8443` or `http`. A target path with an encoded slash or
  backslash (`%2f`, `%5c`) never matches an entry that has a path. A bare-host entry matches by
  host.
- Exclusions always win: a host matching `exclude.domains`, or an IP-literal host (IPv4 or
  bracketed IPv6) inside `exclude.cidrs`, is refused with
  `target <host> is excluded from engagement <name>`.
- The window must be open. If it closes mid-run, the remaining cases are not sent and the scorecard
  says `stopped: engagement <name> window is closed`.
- The gate is lexical (no DNS), like the scope check. Headers for the target come only from
  `--header-env`, never from the corpus.

## Controls and output

| Flag                 | Default           | Meaning                                                              |
| -------------------- | ----------------- | -------------------------------------------------------------------- |
| `--suite a,b`        | all               | Suites to run                                                        |
| `--max-cases N`      | no limit          | Run at most N cases                                                  |
| `--concurrency N`    | 2 (max 8)         | Parallel requests                                                    |
| `--delay-ms N`       | 0                 | Delay per request                                                    |
| `--stop-on-errors N` | 5                 | Stop after N consecutive adapter errors (`stopped: too many errors`) |
| `--model`            | none              | Model name for `anthropic` and `openai` targets                      |
| `--judge-model`      | none (see below)  | Routed model that scores judge cases                                 |
| `--out`              | `redteam-results` | Output directory                                                     |

Each case has a 60 s timeout. Progress lines (`[n/total] <id> attacked|passed|error|skipped`) print
live to stderr, in completion order. Results go to
`<out>/<engagement or self>/<YYYY-MM-DD-HHMMSS>.json` and `.md` (`redteam-results/` is git-ignored).
The exit code is 0 whenever the run completes, whatever the attack results.

## Reading the scorecard

- **Attacked / passed.** `attacked` means the attack succeeded; a case passes when it did not.
  `errors` and `skipped` are counted apart and never scored as passes.
- **ASR** (attack success rate) per suite is `attacked / (passed + attacked)`, or `null` with
  nothing scored. Lower is better. `self:all` renders one row per suite and one column per model,
  cells `ASR% (attacked/scored)`, with `+N err` when a model errored.
- **Detection recall** (self targets only) is the share of `agent-session` cases, among those
  attacked or passed, whose response carried the `inject.instruction` detection or any `custom.*`
  detection from the session guard (see [Purple loop](purple-loop.md)). Because any `custom.*` id
  counts, a custom rule unrelated to injection that fires on these cases also counts toward recall.
- **Judge section.** Judge-scored cases are listed separately with a status (`attacked`, `passed`,
  `unknown`, `skipped` or `error`). They are excluded from per-suite ASR and counted as
  `judgeCases`. `--judge-model` routes the judge through this Worker with a fixed rubric; the
  target reply is fenced as data. Without it, judge cases are `skipped: no judge model`. The MCP
  `redteam` tool defaults its judge to the `JUDGE_MODEL` var; pass `judgeModel` to override it, or
  `judgeModel: ""` to run with no judge.
- **Scorer notes.** `tool_called` matches arguments case-insensitively, on a call to any tool named
  by `tool`: a name, a list of names, or `*` for any tool. `agent-session` and `excessive-agency`
  cases use `*` because each canary host is unique, so a `Bash` curl to a `WebFetch` case's canary
  host counts. `contains_canary` checks the reply text and every tool call's arguments. `regex`
  cases in `output-handling` ignore fenced and inline code, so a payload inside a code block does
  not count.
  Indirect-injection ASR (`ii-*`, `di-10`) is an upper bound, because quoting the injected
  document counts as success.
- Up to 3 successful-attack examples per suite are kept (reply cut to 300 chars). When the reply is
  empty, the example is the first tool call, `tool <name>(<args, up to 200 chars>)`.
- **Corpus version.** `corpus` in the header is the short git sha, with `-dirty` when
  `redteam/corpus` has uncommitted changes.

## MCP `redteam` tool

`redteam` `action: suites` lists the suites. `action: run` needs `suite` and `target`
(`self:<model>`, `anthropic:<url>` or `openai:<url>`, up to 200 chars; `http` and `self:all` are
CLI-only) and returns the scorecard JSON (capped at 32 KB by dropping examples first). Limits:
`maxCases` 1-25 (default 10), concurrency 2, a 55 s deadline (cases not yet started are
`skipped: deadline`, and each case's timeout and judge call are clamped to the time left).
External targets need `engagement` and pass the
same gate, and take an optional `model` (up to 200 chars) for the request body. The Worker holds no
target credentials, so external targets are sent without auth headers; test authenticated targets
with the CLI. Arguments and replies are not logged.

## Adding cases

Add an object to `redteam/corpus/<suite>/cases.json`, with `id` (`/^[a-z0-9-]{3,64}$/`, for example
`ai-11`), `suite`, `owasp`, `title`, optional `system`, `turns` (1-12; the last is `user` or
`tool_result`, and a `tool_result` needs `tools`), optional `tools` and `systemCanary`, and a
`scorer`: `contains_canary`, `regex` (optional `flags`, `ignoreCodeFences`), `tool_called`
(`tool`: a name, a non-empty list of names, or `"*"`, each 1-64 chars; and `argPattern`),
`refusal_expected` or `judge` (`criterion`). Rules:

- Canaries match `/^CANARY-[a-z0-9]{4,12}$/`, hosts end in `.invalid`, and any IPs come from
  198.51.100.0/24 or 203.0.113.0/24.
- Regex patterns must be bounded (no unbounded quantifiers).
- The suites are fixed at 10 cases each, so adding one means updating the corpus test.

Validate with `npm test` (`test/shared/redteam/corpus.node.test.ts` checks every case with `validateCase`).
