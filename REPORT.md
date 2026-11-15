# REPORT — git forge bounty entry (`github-core-clone-01`)

**Status: built and verified locally. NOT submitted — submission still needs the
repo created under `cariuang15`, the transcript bundle, and the make.fun form.**

- Bounty: https://make.fun/bounty/github-core-clone-01 — $500, 20 places,
  ends Sat 21 Nov 2026 13:30 WIB.
- Entrant: @warisan on make.fun (wallet `6YHjbtH61VKjN7u214mXfn8vC4N6xfZeVaVmCzEXmpV8`,
  referral `csc1bejp`). GitHub account for the repo: **cariuang15**
  (0x23466 is flagged by GitHub — do not use it).
- Workspace: `~/workspace/makefun-gitforge/` (repo files only, 143 KiB total,
  largest file 41 KiB — far under the 16 MiB / 8 MiB limits).
  Kit (never committed): `~/workspace/makefun-gitforge-kit/`.

## What was built

A standalone GitHub-compatible git forge in Node 22 erasable TypeScript, stdlib
only, no dependencies, no git binary, one process, in-memory store:

- `main.ts` — the kit starter's lifecycle, unchanged (bind ephemeral port,
  POST `$MAKEFUN_ENV_URL/register`, poll `/done`, exit 0).
- `app.ts` — node:http server: routing, bearer auth (`MAKEFUN_SHOP_TOKEN`),
  `X-GitHub-Request-Id` on every reply, JSON body parsing (400 on malformed).
- `src/store.ts` — repos/issues/pulls; SHA-1 git objects; pack read
  (v2/v3, OFS_DELTA + REF_DELTA, trailer checksum) and write (plain objects);
  fetch selection (haves exclusion, depth, shallow/unshallow, deepen-since,
  deepen-not); refs, merge-base, three-way merge/conflict, squash merge.
- `src/git.ts` — pkt-line codec; info/refs v2 (ls-refs, fetch=shallow) and v0;
  upload-pack v2 `ls-refs`/`fetch` and v0 fetch; receive-pack v0 with
  per-ref ok/ng (`non-fast-forward`), sideband report.
- `src/rest.ts` — all `/api/v3` routes (repos, branches, commits, contents,
  labels, issues, comments, pulls, merge).
- `src/graphql.ts` — a small GraphQL lexer/parser/executor: viewer,
  repository, issue/pull-request connections (cursor pagination, CREATED_AT
  ordering), `node`, `__type`, batching, and the five mutations.
- `src/mcp.ts` — MCP revision 2026-07-28 (`server/discover`, legacy
  `initialize` fallback), 8 tools including the six required ones, same store
  as REST.
- `dev.ts` — local runner without an env (test helper only).

## Verification (all local, against the kit's own sealed suite)

The kit ships a local runner for the exact checks the trial runs
(`sdk/run.ts`). Results on this VM, fresh server each run:

| Run | feature | agent | perf | score | working |
| --- | --- | --- | --- | --- | --- |
| Conformance, 16 Nov 2026 | **600/600** (120/120) | **200/200** (15/15) | — | 800 | 1 |
| Conformance + perf, 16 Nov 2026 | 600/600 | 200/200 | **182/200** | **982** | 1 |
| Conformance re-run (stability) | 600/600 | 200/200 | — | 800 | 1 |

Per-group: git 30/30, repos 15/15, issues 15/15, pulls 20/20, graphql 20/20,
mcp 15/15, protocol 5/5.

Perf (median of 3 rounds, this VM with 1.5 shared CPUs; T_ref = house median):

| Workload | p50 | T_ref | Points |
| --- | --- | --- | --- |
| push (200 × 1 KiB pushes) | 622.9 ms | 1640.82 ms | 42 |
| clone (50 concurrent depth-1 clones, 200 commits) | 91.2 ms | 266.94 ms | 44 |
| read (2,000 GET issue) | 756.1 ms | 2759.72 ms | 48 |
| write (200 POST issue) | 100.0 ms | 348.97 ms | 48 |

The house reference scores ~100 perf (~700 total); this entry beats it on
every workload. `perf_p50_us` 255,935. Timings on the production cluster
(2 CPUs) may differ from this VM.

Also verified by hand: real `git` CLI push / full clone / `--depth 1` clone /
incremental fetch / deepen / annotated tags against the server; a 67-assertion
REST+GraphQL+MCP smoke script (`/tmp/test-forge.mjs`, 67/67); and the
`main.ts` lifecycle against a fake env (registered on an ephemeral port,
served while waiting, exited 0 on `done`).

Bugs found and fixed during testing (all confirmed by the suite, not by hand
alone): v2 fetch must omit the `acknowledgments` section when the client sent
`done`; the receive-pack report needs its flush *inside* band 1; `listRefs`
called `peelToCommit` on the repo instead of the store; incremental fetch
re-sent blobs shared with held trees; deepen fetch never descended through a
held tip (two causes: the walk stopped at held commits, and the exclusion
closure walked the full ancestry of a shallow have).

## Submission steps still needed

1. Create the public repo under **cariuang15** (device Chrome, as with the
   aggregator/token-radar repos): upload the contents of
   `~/workspace/makefun-gitforge/` (12 files), add `.makefun/owner.json`
   with `{"wallet": "6YHjbtH61VKjN7u214mXfn8vC4N6xfZeVaVmCzEXmpV8"}` in a
   commit, record the full 40-char SHA. Verify via `api.github.com` (HTTP 200).
   Do NOT commit the kit (`~/workspace/makefun-gitforge-kit/`).
2. Build the transcript bundle with the kit CLI (`node cli/makefun.mjs bundle
   --repo ~/workspace/makefun-gitforge --out <bundle>.tar.gz --no-discover
   --no-family --session <main session> --session <this session>
   --muse-usage <usage rows> --provider meta --harness-version 1.3
   --effort default --mcp none`), then run the kit's `check` on it.
   This session's id is `a20c7786-e32f-41a8-9cd5-eda0e36ebc96`; the main agent
   session is `8bd63168-5867-41e1-8711-17481364bd17`.
3. Submit on https://make.fun/bounty/github-core-clone-01 with the repo URL,
   the commit SHA and the bundle (MetaMask sign-in). Max 5 submissions/day,
   10 total; the last before the deadline is final. Deadline **Sat 21 Nov
   2026 13:30 WIB**.
4. If the transcript gate names failed checks, fix per its messages and
   resubmit. Known gate risks (same as the chess entry): `thinking_priced`
   (whether make.fun's pricer knows model `ipnext/avocado-5.17-v2`) and
   `thinking_reproduces` (all source files here are agent-authored, so this
   should be strong, unlike the packed chess `main.py`).

## Honest limits

- No server-side grade exists for this bounty beyond the local runner: the
  final grade runs the same sealed checks on fresh seeded instances in the
  trial pod. A green local run is evidence, not a guarantee — but the local
  runner is byte-identical to the sealed suite (per the kit's own header).
- Perf numbers were measured on this VM (1.5 shared CPUs), not the production
  cluster; the graded medians will differ. The entry is faster than the house
  on all four workloads locally by 2.6×–3.6×, so it has margin.
- The forge keeps everything in memory: a trial restart loses state (the
  suite never restarts it mid-trial, and the export is byte-deterministic).
- No `deepen-since`/`deepen-not` check exists in the suite; those paths are
  implemented but only lightly exercised (real-git `--deepen` and the kit's
  deepen checks are covered).
- The entry has no UI, no persistence, no auth beyond the one bearer token —
  that is the brief, not a gap.
