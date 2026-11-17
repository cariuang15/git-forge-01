# gitforge — a standalone GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/cariuang15/git-forge-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/cariuang15/git-forge-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

One Node process, no dependencies, no git binary, no network. It serves the four
surfaces the make.fun `github-core-clone-01` suite drives, from its own in-memory
store:

- **git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 upload-pack
  (`ls-refs`, `fetch` with shallow/deepen), v0 upload-pack, v0 receive-pack
  (report-status, side-band-64k, delete-refs), full packfile read/write
  (SHA-1, zlib, OFS_DELTA + REF_DELTA, trailer checksum).
- **REST v3** at `/api/v3` — repositories, branches, commits, contents, labels,
  issues, comments, pull requests, merges (squash, three-way conflict check).
- **GraphQL v4** at `/api/graphql` — viewer, repository, issues/pull-requests
  connections with cursor pagination and ordering, `node`, `__type`
  introspection, and the five mutations (create/close issue, create/merge pull
  request, add comment). Global ids are opaque base64 `Kind:id`.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
  (`server/discover`, legacy `initialize` fallback), 8 tools including the six
  required ones, acting on the same store as REST.

## Run it

```sh
npm start            # needs MAKEFUN_ENV_URL (the trial env) + MAKEFUN_SHOP_TOKEN
```

The entry binds an ephemeral port, POSTs it to `$MAKEFUN_ENV_URL/register`, then
polls `$MAKEFUN_ENV_URL/done` until the suite finishes and exits 0 (see
`main.ts`, kept as the kit's starter lifecycle).

For local testing without an env:

```sh
MAKEFUN_SHOP_TOKEN=test-token PORT=3000 node --experimental-strip-types dev.ts
```

Then, for example:

```sh
curl -H "Authorization: Bearer test-token" http://127.0.0.1:3000/api/v3/user
git -c http.extraHeader="Authorization: Bearer test-token" \
  clone http://127.0.0.1:3000/adaiversen/<repo>.git
```

## Test it

The kit's own sealed suite runs locally against a server you started:

```sh
node --experimental-strip-types \
  ~/workspace/makefun-gitforge-kit/github-core-clone-01-kit/sdk/run.ts \
  --url http://127.0.0.1:3000 --token test-token [--perf]
```

A small smoke script for the REST/GraphQL/MCP surfaces lives at
`/tmp/test-forge.mjs` (not part of the repo).

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | Entry lifecycle (starter, unchanged): bind, register, wait for done. |
| `app.ts` | The HTTP server: routing, auth, request ids, body parsing. |
| `src/store.ts` | The store: repos, git objects, packs, fetch selection, issues/pulls, merges. |
| `src/git.ts` | pkt-lines, info/refs, upload-pack v2/v0, receive-pack. |
| `src/rest.ts` | All `/api/v3` routes. |
| `src/graphql.ts` | GraphQL lexer, parser and executor. |
| `src/mcp.ts` | MCP `server/discover`, `tools/list`, `tools/call`. |
| `dev.ts` | Local dev runner (no env needed). Not part of the entry contract. |

Auth: when `MAKEFUN_SHOP_TOKEN` is set, a request needs exactly that bearer
token; `/healthz`, `GET /api/v3/` and `GET /api/v3/meta` are public. When the
token is unset (local practice only), any non-empty bearer is accepted.

Determinism: every timestamp the forge mints is fixed (2025-01-01), ids come
from sequential counters, and no `Date.now`/`Math.random` touches stored state
— two runs on the same instance leave byte-identical state.

---

<sub>Entered on [make.fun](https://make.fun/?ref=csc1bejp&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
