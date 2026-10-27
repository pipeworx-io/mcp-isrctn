interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Decode a body from its BYTES, choosing the charset in a stated order and
 * saying which rule chose it.
 *
 * Why this exists (fleet #2742, #2729): the egress relay read an ISO-8859-1
 * page with `Response.text()`, which assumes UTF-8 when the header carries no
 * charset, and re-wrapped the result. Every 0xA7 byte -- the section sign in a
 * statute index -- became EF BF BD (U+FFFD), and the output still read as
 * plausible text. The bytes were gone before anything could notice. The rule
 * that follows from it: read bytes, hash bytes, THEN decode, and never let the
 * decoder guess silently.
 *
 * Resolution order (reported as `charset_source`):
 *   1. `bom`           a byte-order mark (UTF-8, UTF-16LE, UTF-16BE)
 *   2. `content-type`  `charset=` on the Content-Type header
 *   3. `html-meta`     `<meta charset>` or `http-equiv` Content-Type in the
 *                      first 1,024 bytes
 *   4. `xml-decl`      `<?xml ... encoding="...">` at the start of the body
 *   5. `utf8-valid`    the bytes decode as UTF-8 with `fatal: true`
 *   6. `fallback`      windows-1252, which is what WHATWG decodes `iso-8859-1`
 *                      as anyway, and which maps every byte to a character
 *
 * A label the runtime's TextDecoder does not know is skipped and the next rule
 * is tried; `ignored_labels` names it so a caller can see the page lied.
 *
 * `decode_replacements` counts U+FFFD characters that DECODING introduced --
 * the ones already present in the source as UTF-8 EF BF BD are subtracted.
 * Non-zero means the text is lossy; the bytes (and any hash over them) are not.
 */

type CharsetSource = 'bom' | 'content-type' | 'html-meta' | 'xml-decl' | 'utf8-valid' | 'fallback';

interface CharsetChoice {
  /** The WHATWG encoding name TextDecoder resolved the label to. */
  charset: string;
  charset_source: CharsetSource;
  /** Labels found in the header/meta/decl that TextDecoder rejected. */
  ignored_labels: string[];
  /** BOM bytes to skip (TextDecoder strips a matching BOM itself; kept for callers that slice). */
  bom_length: number;
}

interface DecodedText extends CharsetChoice {
  text: string;
  decode_replacements: number;
}

const META_SCAN_BYTES = 1024;

/** Normalize a label through TextDecoder; null when the runtime does not know it. */
function resolveLabel(label: string): string | null {
  const l = label.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!l) return null;
  try {
    return new TextDecoder(l).encoding;
  } catch {
    return null;
  }
}

/** The `charset=` parameter of a Content-Type header value, or null. */
function contentTypeCharset(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const m = /;\s*charset\s*=\s*("?)([^";\s]+)\1/i.exec(contentType);
  return m ? m[2] : null;
}

function bomOf(b: Uint8Array): { charset: string; length: number } | null {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { charset: 'utf-8', length: 3 };
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return { charset: 'utf-16be', length: 2 };
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { charset: 'utf-16le', length: 2 };
  return null;
}

/** ASCII view of the first `n` bytes. Bytes > 0x7F become '?' so regexes stay ASCII-only. */
function asciiHead(b: Uint8Array, n: number): string {
  const end = Math.min(b.length, n);
  let s = '';
  for (let i = 0; i < end; i++) s += b[i] < 0x80 ? String.fromCharCode(b[i]) : '?';
  return s;
}

function metaCharset(head: string): string | null {
  // <meta charset="x"> and <meta http-equiv="Content-Type" content="text/html; charset=x">
  // both reduce to "charset=" inside a <meta ...> tag.
  const tagRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(head))) {
    const c = /charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i.exec(m[0]);
    if (c) return c[1];
  }
  return null;
}

function xmlDeclCharset(head: string): string | null {
  const m = /^\s*<\?xml\b[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/i.exec(head);
  return m ? m[1] : null;
}

function isValidUtf8(b: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b);
    return true;
  } catch {
    return false;
  }
}

/** Choose a charset for `bytes` without decoding the whole body. */
function chooseCharset(bytes: Uint8Array, contentType?: string | null): CharsetChoice {
  const ignored: string[] = [];
  const bom = bomOf(bytes);
  if (bom) return { charset: bom.charset, charset_source: 'bom', ignored_labels: ignored, bom_length: bom.length };

  const header = contentTypeCharset(contentType);
  if (header) {
    const r = resolveLabel(header);
    if (r) return { charset: r, charset_source: 'content-type', ignored_labels: ignored, bom_length: 0 };
    ignored.push(header);
  }

  const head = asciiHead(bytes, META_SCAN_BYTES);
  const meta = metaCharset(head);
  if (meta) {
    let r = resolveLabel(meta);
    // HTML spec: a meta declaring UTF-16 is a lie (the meta itself was readable
    // as ASCII), so it means UTF-8.
    if (r === 'utf-16le' || r === 'utf-16be') r = 'utf-8';
    if (r) return { charset: r, charset_source: 'html-meta', ignored_labels: ignored, bom_length: 0 };
    ignored.push(meta);
  }

  const decl = xmlDeclCharset(head);
  if (decl) {
    const r = resolveLabel(decl);
    if (r) return { charset: r, charset_source: 'xml-decl', ignored_labels: ignored, bom_length: 0 };
    ignored.push(decl);
  }

  if (isValidUtf8(bytes)) return { charset: 'utf-8', charset_source: 'utf8-valid', ignored_labels: ignored, bom_length: 0 };
  return { charset: 'windows-1252', charset_source: 'fallback', ignored_labels: ignored, bom_length: 0 };
}

function countFffdInText(s: string): number {
  let n = 0;
  for (let i = s.indexOf('\uFFFD'); i !== -1; i = s.indexOf('\uFFFD', i + 1)) n++;
  return n;
}

function countEfBfBd(b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i + 2 < b.length; i++) {
    if (b[i] === 0xef && b[i + 1] === 0xbf && b[i + 2] === 0xbd) {
      n++;
      i += 2;
    }
  }
  return n;
}

/**
 * Decode `bytes` with an already-chosen charset (e.g. one chosen over a whole
 * body, applied to a window of it). Counts only the U+FFFD that decoding
 * introduced.
 */
function decodeWithCharset(bytes: Uint8Array, charset: string): { text: string; decode_replacements: number } {
  // TextDecoder strips a BOM that matches its own encoding; ignoreBOM:false is the default.
  const text = new TextDecoder(charset).decode(bytes);
  const present = charset === 'utf-8' ? countEfBfBd(bytes) : 0;
  return { text, decode_replacements: Math.max(0, countFffdInText(text) - present) };
}

/**
 * Decode `bytes` to text. `bytes` is never modified; hash it before or after,
 * the answer is the same.
 */
function decodeBytes(bytes: Uint8Array, contentType?: string | null): DecodedText {
  const choice = chooseCharset(bytes, contentType);
  return { ...choice, ...decodeWithCharset(bytes, choice.charset) };
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * ISRCTN — the UK-based international clinical trial registry
 * (isrctn.com, part of Springer Nature / BMC).
 *
 * Search and single-record lookup against ISRCTN's public, keyless XML query
 * API. ISRCTN's own registration form captures no explicit "overall status"
 * string, so `status` here is DERIVED from the trial's recruitment-window
 * dates (recruitmentStart/recruitmentEnd/overallEndDate) relative to now, and
 * every record says so via `status_basis` — never presented as an
 * authoritative registry field.
 *
 * Tools:
 * - isrctn_search: search by free text and/or condition/intervention fields,
 *   optionally narrowed by a derived recruitment status
 * - isrctn_trial: look up one trial by its ISRCTN number
 */


const UA = 'pipeworx-mcp-isrctn/1.0 (+https://pipeworx.io)';
const UPSTREAM = 'ISRCTN';
const BASE = 'https://www.isrctn.com/api/query/format/default';
const REGISTRY_BASE = 'https://www.isrctn.com';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, Accept: 'application/xml', ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, UPSTREAM);
}

/* ── XML helpers (regex-over-XML; same shape used across arkansas-code,
 *    hawaii-code, sdmx-structure, press-wire packs — no DOM in Workers, and
 *    every feed in the wild bends the spec in some small way). ─────────── */

function xmlTag(block: string, name: string): string | undefined {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`);
  const m = block.match(re);
  if (!m) return undefined;
  const v = decodeXmlEntities(unwrapCdata(m[1])).trim();
  return v || undefined;
}

function xmlBlocks(xml: string, name: string): string[] {
  const re = new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}>`, 'g');
  return xml.match(re) ?? [];
}

function xmlOpenAttr(block: string, tagName: string, attr: string): string | undefined {
  const openTagMatch = block.match(new RegExp(`<${tagName}\\b([^>]*)>`));
  if (!openTagMatch) return undefined;
  const m = openTagMatch[1].match(new RegExp(`${attr}="([^"]*)"`));
  return m ? decodeXmlEntities(m[1]) : undefined;
}

function unwrapCdata(s: string): string {
  const m = s.trim().match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return m ? m[1] : s;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/* ── Lucene query escaping ────────────────────────────────────────────── */

/** Escape a BARE (unquoted) lucene clause — reserved chars lose their meaning. */
function escapeLuceneTerm(s: string): string {
  return s.replace(/([+\-!(){}[\]^"~*?:\\/])/g, '\\$1');
}

/** Escape text that will sit inside a double-quoted lucene phrase. */
function escapeLucenePhrase(s: string): string {
  return s.replace(/([\\"])/g, '\\$1');
}

/* ── Record shape ─────────────────────────────────────────────────────── */

interface IsrctnCondition {
  description?: string;
  disease_class?: string;
}

interface IsrctnIntervention {
  description?: string;
  type?: string;
  phase?: string;
  drug_names?: string;
}

interface IsrctnSponsor {
  organisation?: string;
  type?: string;
  commercial_status?: string;
}

interface IsrctnTrial {
  isrctn_id: string;
  registry_url: string;
  title?: string;
  scientific_title?: string;
  acronym?: string;
  conditions: IsrctnCondition[];
  interventions: IsrctnIntervention[];
  phase?: string;
  sponsor?: IsrctnSponsor;
  funder_name?: string;
  recruitment_countries: string[];
  recruitment_start?: string;
  recruitment_end?: string;
  overall_end_date?: string;
  status: string;
  status_basis: string;
  version?: string;
  last_updated?: string;
  data_as_of?: string;
  results?: {
    ipd_sharing_statement?: string;
    has_basic_report: boolean;
    has_plain_english_report: boolean;
  };
}

/** Derive a recruitment status from dates — ISRCTN's feed carries no status field. */
function deriveStatus(
  recruitmentStart?: string,
  recruitmentEnd?: string,
  overallEndDate?: string,
  now: Date = new Date(),
): { status: string; basis: string } {
  const start = recruitmentStart ? new Date(recruitmentStart) : undefined;
  const end = recruitmentEnd ? new Date(recruitmentEnd) : undefined;
  const overallEnd = overallEndDate ? new Date(overallEndDate) : undefined;

  if (overallEnd && !isNaN(overallEnd.getTime()) && overallEnd.getTime() < now.getTime()) {
    return { status: 'Completed', basis: `overall trial end date (${overallEndDate}) has passed` };
  }
  if (end && !isNaN(end.getTime())) {
    if (end.getTime() < now.getTime()) {
      return { status: 'Recruitment closed', basis: `recruitment end date (${recruitmentEnd}) has passed` };
    }
    if (start && !isNaN(start.getTime()) && start.getTime() > now.getTime()) {
      return { status: 'Not yet recruiting', basis: `recruitment start date (${recruitmentStart}) is in the future` };
    }
    return { status: 'Recruiting', basis: `today falls within the recruitment window ${recruitmentStart ?? '?'} to ${recruitmentEnd}` };
  }
  if (start && !isNaN(start.getTime())) {
    if (start.getTime() > now.getTime()) {
      return { status: 'Not yet recruiting', basis: `recruitment start date (${recruitmentStart}) is in the future` };
    }
    return { status: 'Recruiting (no recruitment end date on record)', basis: `recruitment started ${recruitmentStart}; no end date given` };
  }
  return { status: 'Unknown', basis: 'the record carries no recruitment start/end or overall end date' };
}

/** Parse one <fullTrial>...</fullTrial> block into a structured record. */
function parseFullTrial(block: string): IsrctnTrial | undefined {
  const trialMatch = block.match(/<trial\b([^>]*)>([\s\S]*?)<\/trial>/);
  if (!trialMatch) return undefined;
  const trialAttrs = trialMatch[1];
  const trialBody = trialMatch[2];

  const idMatch = trialAttrs.match(/publicIdentifierCanonical="([^"]*)"/);
  const isrctnId = idMatch ? idMatch[1] : undefined;
  if (!isrctnId) return undefined;

  const lastUpdatedMatch = trialAttrs.match(/lastUpdated="([^"]*)"/);
  const versionMatch = trialAttrs.match(/version="([^"]*)"/);

  const descBlock = xmlTag(trialBody, 'trialDescription');
  const descBlockRaw = (trialBody.match(/<trialDescription\b[^>]*>([\s\S]*?)<\/trialDescription>/) ?? [])[1] ?? '';
  const title = xmlTag(descBlockRaw, 'title') ?? descBlock;
  const scientificTitle = xmlTag(descBlockRaw, 'scientificTitle');
  const acronym = xmlTag(descBlockRaw, 'acronym');

  const designBlockRaw = (trialBody.match(/<trialDesign\b[^>]*>([\s\S]*?)<\/trialDesign>/) ?? [])[1] ?? '';
  const overallEndDate = xmlTag(designBlockRaw, 'overallEndDate');

  const participantsBlockRaw = (trialBody.match(/<participants\b[^>]*>([\s\S]*?)<\/participants>/) ?? [])[1] ?? '';
  const recruitmentStart = xmlTag(participantsBlockRaw, 'recruitmentStart');
  const recruitmentEnd = xmlTag(participantsBlockRaw, 'recruitmentEnd');
  const recruitmentCountriesRaw = (participantsBlockRaw.match(/<recruitmentCountries\b[^>]*>([\s\S]*?)<\/recruitmentCountries>/) ?? [])[1] ?? '';
  const recruitmentCountries = xmlBlocks(recruitmentCountriesRaw, 'country')
    .map((b) => xmlTag(b, 'country'))
    .filter((v): v is string => !!v);

  const conditionsRaw = (trialBody.match(/<conditions\b[^>]*>([\s\S]*?)<\/conditions>/) ?? [])[1] ?? '';
  const conditions: IsrctnCondition[] = xmlBlocks(conditionsRaw, 'condition').map((b) => ({
    description: xmlTag(b, 'description'),
    disease_class: xmlTag(b, 'diseaseClass1'),
  }));

  const interventionsRaw = (trialBody.match(/<interventions\b[^>]*>([\s\S]*?)<\/interventions>/) ?? [])[1] ?? '';
  const interventions: IsrctnIntervention[] = xmlBlocks(interventionsRaw, 'intervention').map((b) => ({
    description: xmlTag(b, 'description'),
    type: xmlTag(b, 'interventionType'),
    phase: xmlTag(b, 'phase'),
    drug_names: xmlTag(b, 'drugNames'),
  }));
  const phase = interventions.find((iv) => iv.phase)?.phase;

  const resultsRaw = (trialBody.match(/<results\b[^>]*>([\s\S]*?)<\/results>/) ?? [])[1] ?? '';
  const ipdSharingStatement = xmlTag(resultsRaw, 'ipdSharingStatement');
  const basicReport = xmlTag(resultsRaw, 'basicReport');
  const plainEnglishReport = xmlTag(resultsRaw, 'plainEnglishReport');

  const partiesRaw = (trialBody.match(/<parties\b[^>]*>([\s\S]*?)<\/parties>/) ?? [])[1] ?? '';
  const sponsorId = xmlTag(partiesRaw, 'sponsorId');
  const funderId = xmlTag(partiesRaw, 'funderId');

  let sponsor: IsrctnSponsor | undefined;
  if (sponsorId) {
    const sponsorBlock = xmlBlocks(block, 'sponsor').find((b) => xmlOpenAttr(b, 'sponsor', 'id') === sponsorId);
    if (sponsorBlock) {
      sponsor = {
        organisation: xmlTag(sponsorBlock, 'organisation'),
        type: xmlTag(sponsorBlock, 'sponsorType'),
        commercial_status: xmlTag(sponsorBlock, 'commercialStatus'),
      };
    }
  }

  let funderName: string | undefined;
  if (funderId) {
    const funderBlock = xmlBlocks(block, 'funder').find((b) => xmlOpenAttr(b, 'funder', 'id') === funderId);
    if (funderBlock) funderName = xmlTag(funderBlock, 'name');
  }

  const { status, basis } = deriveStatus(recruitmentStart, recruitmentEnd, overallEndDate);

  return {
    isrctn_id: isrctnId,
    registry_url: `${REGISTRY_BASE}/${isrctnId}`,
    title,
    scientific_title: scientificTitle,
    acronym,
    conditions,
    interventions,
    phase,
    sponsor,
    funder_name: funderName,
    recruitment_countries: recruitmentCountries,
    recruitment_start: recruitmentStart,
    recruitment_end: recruitmentEnd,
    overall_end_date: overallEndDate,
    status,
    status_basis: basis,
    version: versionMatch ? versionMatch[1] : undefined,
    last_updated: lastUpdatedMatch ? lastUpdatedMatch[1] : undefined,
    data_as_of: lastUpdatedMatch ? lastUpdatedMatch[1] : undefined,
    results: {
      ipd_sharing_statement: ipdSharingStatement,
      has_basic_report: !!basicReport,
      has_plain_english_report: !!plainEnglishReport,
    },
  };
}

interface IsrctnQueryResult {
  totalCount: number;
  trials: IsrctnTrial[];
}

/** Run one query against the ISRCTN XML search endpoint and parse it. */
async function runQuery(q: string, limit: number): Promise<IsrctnQueryResult> {
  const url = new URL(BASE);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(limit));

  const res = await pwFetch(url);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const { text } = decodeBytes(bytes, res.headers.get('content-type'));

  if (!res.ok) {
    throw new Error(
      `${UPSTREAM} returned HTTP ${res.status} for query "${q}" — ${text.slice(0, 300) || '(empty body)'}`,
    );
  }

  const totalMatch = text.match(/<allTrials\b[^>]*\btotalCount="(\d+)"/);
  if (!totalMatch) {
    throw new Error(
      `upstream_parse: ${UPSTREAM} answered query "${q}" with HTTP 200 but the response (${text.length} chars, starts "${text.slice(0, 120).replace(/\s+/g, ' ')}") carries no <allTrials totalCount="…"> root — the XML shape this tool parses may have changed upstream.`,
    );
  }
  const totalCount = Number(totalMatch[1]);

  const fullTrialBlocks = xmlBlocks(text, 'fullTrial');
  if (totalCount > 0 && fullTrialBlocks.length === 0) {
    throw new Error(
      `upstream_parse: ${UPSTREAM} reported totalCount="${totalCount}" for query "${q}" but the response contained zero <fullTrial> blocks — the XML shape this tool parses may have changed upstream.`,
    );
  }

  const trials: IsrctnTrial[] = [];
  for (const block of fullTrialBlocks) {
    const parsed = parseFullTrial(block);
    if (parsed) trials.push(parsed);
  }
  if (totalCount > 0 && trials.length === 0) {
    throw new Error(
      `upstream_parse: ${UPSTREAM} returned ${fullTrialBlocks.length} <fullTrial> block(s) for query "${q}" (totalCount="${totalCount}") but none of them parsed into a trial — the <trial publicIdentifierCanonical="…"> attribute this tool keys on may have changed upstream.`,
    );
  }

  return { totalCount, trials };
}

/* ── Tool definitions ─────────────────────────────────────────────────── */

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

const tools: McpToolExport['tools'] = [
  {
    name: 'isrctn_search',
    description:
      'Search the ISRCTN registry (isrctn.com) — the UK-based international clinical trial registry — by free text and/or by condition/intervention. Use for "studies on <condition> and <drug/intervention>", "trials of psilocybin for depression", or any UK/international trial not necessarily registered on ClinicalTrials.gov. At least one of query/condition/intervention is required. Combining condition and intervention narrows to trials registered under BOTH (an AND, not an OR) — a real zero means no ISRCTN trial currently pairs that condition with that intervention, and the tool says so explicitly rather than guessing. `status` filters on a DERIVED recruitment status (ISRCTN\'s feed carries no status field) computed from each trial\'s recruitment dates — see `status_basis` on every returned trial.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Free-text search terms (title, summary, eligibility criteria, etc.) — e.g. "psilocybin" or "psilocybin depression" (multiple words are ANDed, not ORed). Optional if condition and/or intervention are given.',
        },
        condition: {
          type: 'string',
          description: 'Filter to trials whose registered CONDITION field matches this phrase (e.g. "stroke", "treatment-resistant depression").',
        },
        intervention: {
          type: 'string',
          description: 'Filter to trials whose registered INTERVENTION field matches this phrase (e.g. "psilocybin", "COMP360").',
        },
        status: {
          type: 'string',
          description:
            'Filter on the DERIVED recruitment status (case-insensitive substring match) — e.g. "recruiting", "completed", "not yet recruiting". Applied client-side over the fetched batch (see `status_filter_scanned` in the response), since ISRCTN\'s feed has no status field to filter on server-side.',
        },
        limit: {
          type: 'number',
          description: `Max trials to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
        },
      },
      required: [],
    },
  },
  {
    name: 'isrctn_trial',
    description:
      'Look up a single ISRCTN trial by its registry number. Accepts "ISRCTN12345678", "isrctn12345678", or the bare number "12345678". Returns title, condition(s), intervention(s)/phase, derived recruitment status, sponsor, funder, dates, countries, and a note on whether results have been posted.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'The ISRCTN trial number, with or without the "ISRCTN" prefix (e.g. "ISRCTN37167117" or "37167117").',
        },
      },
      required: ['id'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'isrctn_search': {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      const condition = typeof args.condition === 'string' ? args.condition.trim() : '';
      const intervention = typeof args.intervention === 'string' ? args.intervention.trim() : '';
      const statusFilter = typeof args.status === 'string' ? args.status.trim().toLowerCase() : '';

      const clauses: string[] = [];
      if (query) clauses.push(escapeLuceneTerm(query));
      if (condition) clauses.push(`condition:"${escapeLucenePhrase(condition)}"`);
      if (intervention) clauses.push(`intervention:"${escapeLucenePhrase(intervention)}"`);

      if (clauses.length === 0) {
        throw new Error('isrctn_search requires at least one of query, condition, or intervention.');
      }
      const q = clauses.join(' AND ');

      let limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_LIMIT;
      limit = Math.min(Math.max(limit, 1), MAX_LIMIT);

      // Status is filtered client-side (ISRCTN's feed has no status field), so
      // when it is set we fetch a wider batch than the caller's limit to have
      // something to filter against, and say exactly how wide.
      const fetchLimit = statusFilter ? Math.min(Math.max(limit * 5, 30), 100) : limit;

      const { totalCount, trials } = await runQuery(q, fetchLimit);

      let results = trials;
      let statusFilterScanned: number | undefined;
      if (statusFilter) {
        statusFilterScanned = trials.length;
        results = trials.filter((t) => t.status.toLowerCase().includes(statusFilter));
      }
      results = results.slice(0, limit);

      return {
        query_used: q,
        total_count: totalCount,
        returned_count: results.length,
        status_filter: statusFilter || undefined,
        status_filter_scanned: statusFilterScanned,
        trials: results,
        registry: 'ISRCTN (isrctn.com)',
      };
    }

    case 'isrctn_trial': {
      const raw = typeof args.id === 'string' ? args.id.trim() : '';
      if (!raw) throw new Error('isrctn_trial requires `id`.');
      const digits = raw.replace(/^isrctn/i, '').trim();
      if (!/^\d+$/.test(digits)) {
        throw new Error(`isrctn_trial: "${raw}" does not look like an ISRCTN number (expected digits, optionally prefixed "ISRCTN").`);
      }
      const canonicalId = `ISRCTN${digits}`;

      const { totalCount, trials } = await runQuery(canonicalId, 1);
      if (totalCount === 0) {
        return {
          found: false,
          id: canonicalId,
          searched: canonicalId,
          message: `No ISRCTN trial found for ${canonicalId}.`,
          registry: 'ISRCTN (isrctn.com)',
        };
      }

      const trial = trials.find((t) => t.isrctn_id.toUpperCase() === canonicalId.toUpperCase()) ?? trials[0];
      return { found: true, ...trial, registry: 'ISRCTN (isrctn.com)' };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
