# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab
and choose **Report a vulnerability**. Do not open a public issue for a security problem.

Include what you found, how to reproduce it (a request, config or test case), and what an
attacker gains. You should get a first reply within a week.

## In scope

- A way to reach a backend, or the `/mcp` tools, without the proxy key.
- An upstream provider key, `PROXY_KEY` or `CF_API_TOKEN` reaching a client response or a log line.
- A request that makes the Worker fetch a host outside its allowlist.
- A way around the scope check (`POST /v1/guard/check` and the `scope-guard` hook) that lets
  Claude Code act on a target outside the engagement scope.

## Not vulnerabilities

- **The session guard flags; it does not block.** A request or response rule that misses an
  attack is a detection gap. Please report it as a normal issue, ideally with a red-team case.
- **`redteam/corpus/**` and `redteam/purple/**` contain prompt-injection text on purpose.** They
  are test data for the red-team harness and the purple loop.
- Behaviour of the upstream models themselves.

## Supported versions

Only the latest commit on `main` gets fixes.
