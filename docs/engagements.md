# Engagements and modes

An engagement describes what a test is allowed to touch (scope, exclusions, time window). A
mode (`redteam` or `purple`) appends a method and scope pack to the system prompt. Both are
off unless a request opts in.

## Configuring `ENGAGEMENTS`

`ENGAGEMENTS` is a JSON object (stored as a string) keyed by engagement name:

```json
{
    "acme-q4": {
        "scope": {
            "domains": ["acme.example", "*.acme.example"],
            "cidrs": ["203.0.113.0/24"],
            "llmTargets": ["https://llm.acme.example/v1"]
        },
        "exclude": { "domains": ["*.prod.acme.example"], "cidrs": ["203.0.113.5"] },
        "window": { "start": "2026-11-10T09:00:00Z", "end": "2026-11-24T17:00:00+00:00" },
        "roe": "No denial of service. Stop on any production data.",
        "defaultMode": "off"
    }
}
```

```bash
npx wrangler secret put ENGAGEMENTS
```

For local dev, put `ENGAGEMENTS=<json on one line>` in `.dev.vars`. A value that is not a string,
or is not valid JSON, fails closed with `500 invalid config: ENGAGEMENTS` on every request.
The error names the engagement, field and index (`engagement "acme-q4" scope.domains[2]: invalid
domain`), never the offending value.

- **Names** match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Unknown keys are rejected everywhere.
- **Domains** are an exact hostname or `*.` plus a hostname. After IDNA, every label must match
  `^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$` (so `_dmarc.acme.example` works). The wildcard covers
  subdomains at any depth but not the apex. Bare `*` and `*.<tld>` are rejected, as is any
  domain containing `\`, `%`, whitespace or the IDNA deviation characters ß, ẞ, ς, ZWNJ or
  ZWJ. An exact exclusion does not cover subdomains; add `*.x` to exclude those too.
- **CIDRs** are IPv4 or IPv6; a bare IP means /32 or /128. Scope CIDRs shorter than /8 (IPv4)
  or /16 (IPv6) are rejected as too broad; exclusions accept any prefix. Write IPv4-mapped
  ranges as IPv4: IPv6 CIDRs shorter than /96 that overlap `::ffff:0:0/96` are rejected.
- **`window.start` and `window.end`** are ISO 8601 date-times with `Z` or a numeric offset.
  Impossible dates are rejected. The window is inclusive at both ends.
- **`scope`** is required and needs at least one non-empty list (`domains`, `cidrs` or
  `llmTargets`). **`window`** is required and `start` must be before `end`. An empty
  `ENGAGEMENTS` means no engagements.
- **`roe`** (rules of engagement, text for the pack) and **`defaultMode`** are optional.
  `defaultMode` defaults to `off`.

## Headers and mode precedence

Send the headers through `ANTHROPIC_CUSTOM_HEADERS` (newline-separated `Name: value` lines):

```json
"ANTHROPIC_CUSTOM_HEADERS": "x-api-key: your-proxy-key-value\nx-engagement: acme-q4\nx-proxy-mode: redteam"
```

The mode is the first of: the `redteam/` or `purple/` prefix on the model name (stripped before
routing, e.g. `purple/@cf/zai-org/glm-5.3`), then the `x-proxy-mode` header, then the
engagement's `defaultMode`, then `off`. An empty header counts as absent. These return
`400 invalid_request_error`:

- an unknown engagement;
- an invalid `x-proxy-mode` (use `redteam`, `purple` or `off`);
- a mode other than `off` with no engagement;
- an alias prefix with no model after it;
- a `system` that is neither a string nor an array, when a pack would be appended.

The headers and the alias also work on the `/{type}/{provider_url}/v1/messages` path
convention: the alias is stripped before the target model is set, and the pack is appended.

The pack is appended after the user's system prompt and never replaces it. Its parts, in
order: header (engagement and mode), scope, exclusions, window, `roe` (if set), the method,
a stay-in-scope line, the finding format below, and a last line that repeats the scope and
the exclusions (`Scope (repeat): …; excluded: …`).

```text
Write each finding to findings/<id>.md (id: short-kebab-case) with:
# <title>
Severity: critical|high|medium|low|info
ATT&CK: <technique IDs, e.g. T1190>
## Evidence
## Reproduction
## Remediation
```

`POST /v1/messages/count_tokens` counts the pack too.

## Out-of-window detection and logging

A request outside the engagement's window still proceeds. The proxy logs one detection line per
messages request (`count_tokens` does not log it):

```json
{
    "event": "detection",
    "ruleId": "engagement.out_of_window",
    "severity": "medium",
    "requestId": "<id>",
    "engagement": "acme-q4",
    "excerpt": "2026-12-01T10:00:00.000Z outside 2026-11-10T09:00:00.000Z..2026-11-24T17:00:00.000Z"
}
```

The response carries `x-proxy-detections: engagement.out_of_window` (see [Session guard](guard.md)), and
`GUARD_RULES` can disable the rule or change its severity.

The request log line gains `engagement` and `mode` fields (see [Rate limiting and logging](configuration.md#rate-limiting-and-logging)).

## Scope check

Phases 4-6 will build on `checkScope` in `src/engagement.ts`; it is documented here because
its rules are fixed now. It classifies a host, IP or URL as `in_scope`, `excluded`,
`out_of_scope` or `invalid_target`.

- Hosts are normalized first: lowercase, trailing dot removed, IDNA (punycode), IPv4 forms and
  IPv4-mapped IPv6 (`::ffff:1.2.3.4` is `1.2.3.4`).
- Exclusions win over scope matches.
- Matching is lexical: there are no DNS lookups, so a hostname that resolves into an excluded
  CIDR is still `in_scope`. Exclude the hostname too.
- An input is `invalid_target` if it contains `\`, an IDNA deviation character (ß, ẞ, ς,
  ZWNJ, ZWJ; same rule as config domains), or a host label outside the config label rule above,
  such as `$(id).acme.example`, `a;b.acme.example` or `*.acme.example`. `_` is allowed.
- `llmTargets` only match real `http(s)://` URL inputs (a bare host never matches one), on the
  same protocol, host and port, plus a path-prefix boundary
  (`/v1` matches `/v1` and `/v1/x`, not `/v10`). A path containing an encoded slash or
  backslash (`%2f`, `%5c`) never matches a target that has a path.
- Non-canonical IPv4 spellings such as `0xCB.0.113.5` are accepted and canonicalized to
  `203.0.113.5`, because the WHATWG URL parser does so.
- A CIDR argument (`10.10.1.0/24`, `2001:db8::/48`) is `in_scope` only when one scope CIDR
  wholly contains it. A contained CIDR that overlaps an exclude CIDR is `excluded`; a CIDR not
  wholly inside the scope is `out_of_scope`. A malformed one (`10.0.0.0/33`) is `invalid_target`.

## Scope check endpoint

`POST /v1/guard/check` decides whether one tool call may run during an engagement. The Claude
Code `PreToolUse` hook calls it. Authenticate with `x-api-key` like `/v1/messages`.

```json
{ "engagement": "acme-q4", "tool": "Bash", "input": { "command": "nmap evil.example.org" } }
```

Response `200`:

```json
{
    "decision": "deny",
    "hosts": ["evil.example.org"],
    "reasons": ["evil.example.org is out of scope for engagement acme-q4"]
}
```

- A bad body, a missing or unknown `engagement`, a `tool` that does not match
  `^[A-Za-z0-9_.-]{1,64}$` (MCP names such as `mcp__x__scan` fit) or a non-object `input` is
  `400`; a body over `MAX_BODY_BYTES` is `413`. A closed window is not an error: it is a `deny`
  in the decision.
- No hosts found: `allow`. Loopback hosts (`127.0.0.0/8`, `::1`, `localhost`, `*.localhost`)
  are always allowed; private ranges must be in scope. Any other host that is out of scope,
  excluded or not checkable denies, and so does a closed window when a non-loopback host is present.
- Reasons, in this order:
    - `tool input too large to check (over 1 MB)`
    - `too many targets to check (more than 64)`
    - one reason per host, in the order the hosts were found:
        - `<host> is out of scope for engagement <name>`
        - `<host> is excluded from engagement <name>`
        - `<raw> is not a checkable target; write the literal host`
    - `engagement <name> window is closed`
- Hosts and reasons are redacted like detection excerpts (`ghp_…[redacted].evil.example.org`).
  A target that is not checkable is shown without URL userinfo, and a non-numeric port is shown
  as `:[redacted]`, since it may be a password cut at `#`.
- Each `200` answer logs one `hook.decision` line (engagement, tool, decision, up to 20 redacted
  hosts of at most 200 chars each, reason count). A `4xx` answer logs none.
- The endpoint answers within 50 ms for commands up to about 256 KB; a 1 MB command takes
  100–200 ms.
- Where URL parsers disagree, every reading is checked: `https:/host`, `https:\\host` and a tab or
  newline inside a WebFetch URL (WHATWG strips it: `https://a.acme.com<TAB>.evil.org` reaches
  `a.acme.com.evil.org`), and `http://a.acme.com\@evil.org` (curl and wget reach `evil.org`).
  Octal and hex dotted quads (`0127.0.0.1` is `87.0.0.1`) and IPv6 zone IDs (`fe80::1%eth0`)
  are checked too.

## Scope hook

`claude-code/hooks/scope-guard.mjs` is a dependency-free Node script that registers as a Claude
Code `PreToolUse` hook. During an engagement it sends each Bash, PowerShell or WebFetch call to
`POST /v1/guard/check` and denies the call when the Worker says deny or cannot be reached. It
never auto-approves: an allow is a silent exit, so Claude Code's normal permission prompt still
applies.

The hook needs Node 18 or later (tested on Node 24). **A hook that cannot start fails open:** if
`node` is missing or too old, Claude Code treats the failure as a non-blocking error and runs the
tool unchecked. Use an absolute path to `node` to avoid PATH surprises, and write both paths with
forward slashes (`C:/Program Files/nodejs/node.exe`). The line should work whether hooks run in Git
Bash or in PowerShell on Windows; verify it with [testing.md](testing.md) §13.

Add this to `settings.json`:

```json
{
    "hooks": {
        "PreToolUse": [
            {
                "matcher": "Bash|PowerShell|WebFetch",
                "hooks": [
                    {
                        "type": "command",
                        "command": "\"<absolute path to node>\" \"<absolute path to checkout>/claude-code/hooks/scope-guard.mjs\"",
                        "timeout": 10
                    }
                ]
            }
        ]
    }
}
```

`timeout` is in seconds. The hook itself gives up after 3 s, counted from before it reads its
input, so a stalled stdin also ends in a deny. It never follows a redirect from the Worker.

**When it acts.** Only when `ANTHROPIC_CUSTOM_HEADERS` (newline-separated `Name: Value` lines)
has a non-empty `x-engagement` (with repeated lines, the first non-empty value wins, so a later
empty line cannot switch the hook off) and `PROXY_SCOPE_HOOK` is not `off`. Otherwise it exits silently
without a network call. The endpoint is `/v1/guard/check` on `ANTHROPIC_BASE_URL` (any path in
the base URL is ignored). The key sent as `x-api-key` is the first of: custom header
`x-proxy-key`, custom header `x-api-key`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`.

**Verify that `env` reaches hooks.** Whether the `env` block of `settings.json` is passed to hook
processes is not documented. Set the variables there, trigger a Bash call and confirm the Worker
logs a `hook.decision` line. If it does not, export the variables in the shell that starts Claude
Code.

**Decisions** (made by the Worker, see Scope check endpoint):

| Situation                                                      | Result |
| -------------------------------------------------------------- | ------ |
| No hosts found in the call                                     | allow  |
| Any host out of scope, excluded or not a checkable target      | deny   |
| Window closed and a non-loopback host is present               | deny   |
| Loopback (`127.0.0.0/8`, `::1`, `localhost`, `*.localhost`)    | allow  |
| Private ranges (`10/8`, `192.168/16`, ...) not in scope        | deny   |
| More than 64 targets, or tool input over 1 MB                  | deny   |
| Worker unreachable, timeout, non-200, bad JSON, bad hook input | deny   |

A deny reads `scope-guard (<engagement>): <reasons>`. When the check cannot be completed the
reason is exactly `scope check unavailable; set PROXY_SCOPE_HOOK=off to bypass`. Setting
`PROXY_SCOPE_HOOK=off` (case-insensitive) disables the hook.

**Known limits.** The check is lexical and flag-based, not a sandbox. It does not catch:

- shell indirection: variables, `$(...)`, base64;
- scripts written to a file and then run;
- targets read from files (`nmap -iL`, `wget -i`, `nuclei -l`, `curl -K`);
- obfuscation: a backtick or caret inside a name, an interior `\`, short or decimal IPv4
  (`10.1`, `167772161`), brace expansion (`{a,b}.evil.com`);
- inline interpreter code (`node -e`, `python -c`, …): bare hosts are found only inside quoted
  strings, and Perl `q{}` strings or string concatenation (`'evil.' + 'com'`) hide a host;
- names resolved inside tools;
- single-label hosts outside the engagement's domains;
- two-label names whose last label is on the file-extension list, so that `python setup.py`
  does not deny: `ai`, `am`, `cc`, `gz`, `in`, `java`, `md`, `mk`, `ml`, `mov`, `pl`, `pm`,
  `ps`, `pub`, `py`, `rs`, `sc`, `sh`, `so`, `tf`, `zip`. So `curl mistral.ai` is not checked,
  though URLs with those TLDs are (`https://mistral.ai`);
- tools outside the hook's matcher, such as MCP browser or fetch tools and WebSearch. When MCP
  network tools are in use, add `|mcp__.*` to the matcher (`Bash|PowerShell|WebFetch|mcp__.*`);
  the Worker checks URLs and IPs in every string of an MCP call, and bare hosts in fields named
  `url`, `host`, `target` and the like.

**Cost.** One round trip to the Worker per Bash, PowerShell or WebFetch call while an engagement
is active, up to 3 s when the Worker is slow.
