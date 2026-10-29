# ISRCTN — UK-Based International Clinical Trial Registry

ISRCTN (isrctn.com) is a primary clinical trial registry recognised by WHO and
ICMJE, operated by Springer Nature/BMC. It covers UK and international trials
— including many non-US studies that never appear on ClinicalTrials.gov — and
assigns a permanent ISRCTN number to every registered study. Free, keyless,
public XML query API.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Why this matters for AI agents

ClinicalTrials.gov is US-centric. A question like "what trials exist on
psilocybin for stroke recovery" is only half-answered without ISRCTN, since
several UK/EU-sponsored studies register here instead of (or in addition to)
ClinicalTrials.gov. Use this pack alongside `clinicaltrials` for international
coverage, not in place of it.

Two flows:

**1. Search.** "Studies on X and Y" → `isrctn_search({query: "psilocybin depression"})`
or, to require BOTH a registered condition and a registered intervention,
`isrctn_search({condition: "stroke", intervention: "psilocybin"})`. Combining
`condition` and `intervention` is an AND, not an OR — a real zero means no
ISRCTN trial currently pairs that condition with that intervention, and the
response echoes `query_used` so the caller can see exactly what was searched.

**2. Single record.** `isrctn_trial({id: "ISRCTN37167117"})` → full structured
record: title, condition(s), intervention(s)/phase, sponsor, funder, dates,
countries, and whether a results report has been posted.

## Status is DERIVED, not a registry field

ISRCTN's XML feed carries no "overall trial status" string — unlike
ClinicalTrials.gov. Every returned trial computes `status` from its
recruitment-window dates (`recruitment_start`, `recruitment_end`,
`overall_end_date`) relative to the current date, and `status_basis` names
exactly which date drove the call (e.g. *"overall trial end date
(2025-01-23T00:00:00.000Z) has passed"*). `isrctn_search`'s `status` filter
matches against this derived value and is applied **client-side** over a
fetched batch (`status_filter_scanned` reports how many trials were scanned),
since the upstream has no server-side status field to filter on.

## Search syntax

`query` is free text (ISRCTN's search is a Lucene index over the full record
— title, summary, eligibility criteria, etc.). Multiple words are **ANDed by
default** ("psilocybin depression" matches trials containing both terms, not
either), confirmed against the live API: `psilocybin depression` and
`psilocybin AND depression` return identical counts, `"psilocybin depression"`
(a phrase) returns zero. `condition` and `intervention` match ISRCTN's
indexed `condition:` / `intervention:` fields specifically — these are
narrower than a free-text match on the same word (e.g. `condition:stroke`
returns ~1/4 the hits of a bare `stroke` search, because it excludes trials
that only mention "stroke" in eligibility criteria or elsewhere).

At least one of `query`, `condition`, `intervention` is required.

## Auth

Keyless. Public, unauthenticated XML query API.

## Data sources

- `https://www.isrctn.com/api/query/format/default?q={lucene_query}&limit={n}` —
  search (e.g. `q=psilocybin+depression&limit=10`); also used for single-record
  lookup (`isrctn_trial` queries by the canonical `ISRCTN37167117`-shaped id
  with `limit=1`).

## Notes for the next person

- The single-record URL shape `/api/query/ISRCTN37167117/format/default`
  documented informally elsewhere 404s live (verified 2026-10-09) — the
  working path for one record is the SAME search endpoint, queried by id.
- A non-existent ISRCTN id returns `HTTP 200` with an empty `allTrials` element (`totalCount` of zero)
  — a legitimate empty result, surfaced as `{found: false}`, not an error.
- A malformed Lucene query (e.g. unbalanced quotes) also silently returns
  `totalCount="0"` rather than an HTTP error — user input going into `query`,
  `condition`, and `intervention` is Lucene-escaped before being sent, so a
  caller's literal text (parentheses, colons, quotes) can't accidentally
  produce a false zero from broken query syntax.
- A response that is HTTP 200 but has no `allTrials`/`totalCount` root element, or
  that claims `totalCount > 0` with zero parseable fullTrial blocks, is
  thrown as a loud `upstream_parse` error — never silently returned as an
  empty result.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "isrctn": {
      "url": "https://gateway.pipeworx.io/isrctn/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/isrctn/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/isrctn_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"psilocybin depression","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/isrctn_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-isrctn` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/isrctn/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "isrctn": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-isrctn"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Isrctn data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
