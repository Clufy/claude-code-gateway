# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Set up

You need Node.js 24 or later (the scripts run `.ts` files directly) and npm.

```bash
npm ci
npm run check   # types for src, test and scripts, then formatting
npm test        # the workers and node test projects, fully offline
```

`npm run dev` starts the Worker locally on port 8080. Put secrets such as `PROXY_KEY` in
`.dev.vars`, which is gitignored. Never commit a key.

## Find your way around

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the folder layout, how a request moves through
  the code, and where to make common changes (a new model, backend, config var, guard rule or MCP
  tool).
- [CLAUDE.md](CLAUDE.md): the repository rules in one page. They apply to people as well as agents.

## Rules a pull request must follow

- `npm run check` and `npm test` pass. CI runs both on every pull request.
- Tests mirror `src/`: the tests for `src/<dir>/<file>.ts` go in `test/<dir>/`. Name a test
  `*.node.test.ts` only when it needs Node.
- `src/` runs in workerd: no `node:` imports, no `process`, no `Buffer`. Model ids live in
  `wrangler.jsonc`, never in `src/`.
- Bug fixes come with a test that fails before the fix.
- Larger features start with a short design in `docs/history/specs/`, with a row added to
  [docs/history/README.md](docs/history/README.md).

## Red-team and purple data

`redteam/corpus/**` and `redteam/purple/**` hold deliberate prompt-injection text. When you add
cases, keep them as data and keep real hosts, keys and personal details out of them.

## Security issues

Report them privately; see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
