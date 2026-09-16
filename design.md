# Design

How this project is organised, why it is organised that way, and what is built so far.

[README.md](README.md) covers setup and commands. This document covers structure and decisions —
read it before adding a tool or moving anything in `src/`.

---

## 1. The constraint that shapes everything

**Nothing the user types or generates may leave the browser.**

That is the product. It is also a hard architectural constraint, and almost every decision below
follows from it:

- No backend, no database, no API route. The site is a folder of static files.
- No analytics, no tag manager, no error-reporting SDK, no third-party fonts or assets. The only
  requests are for the site's own code, from its own origin — including the chunks fetched on
  demand (a wordlist, the YAML parser). **No request ever carries user input.** The absence of
  third-party origins is checked at build time (see §9).
- All randomness is generated client-side from the browser's CSPRNG.
- The only thing written to storage is UI preference, never output.

A tool that needs a server does not belong here. If one ever does, it belongs in a separate
project with a separate privacy story, because the value of this one is that the claim is
unconditional.

---

## 2. Stack

| Concern | Choice | Why |
|---|---|---|
| Framework | Astro 7, `output: 'static'` | Ships zero JS by default. Component reuse at build time, plain HTML at runtime. |
| Language | TypeScript, `strict` | The generators are the kind of code where an off-by-one is a security bug. |
| Styling | Hand-written CSS, custom properties | ~1200 lines total. A utility framework would ship more bytes than the entire site. |
| Client JS | Vanilla ES modules | Forms, meters and two textareas. A UI framework would be the single largest asset on the page. |
| Hosting | Vercel, static output | No adapter, no serverless function, no runtime. |
| Verification | `scripts/verify.ts` in Node | See §9. |

**One dependency ships to the browser: `js-yaml`.** It is dynamically imported, so only the YAML
page downloads it, and it is bundled rather than pulled from a CDN. The alternative was writing a
YAML parser, and a formatter that quietly misreads a document is worse than no formatter — YAML is
a large specification with genuinely surprising corners. Everything else on this site is written
from scratch, including MD5, which `crypto.subtle` refuses to implement.

Dev dependencies are `typescript`, `@astrojs/check`, `@types/node`, `esbuild`.

**TypeScript is pinned to `~6.0.3` on purpose.** TypeScript 7's native compiler does not yet expose
the programmatic API that `astro check` uses, and installing it silently breaks `npm run check`.
Do not bump it past 6 until `astro check` supports it.

---

## 3. Source layout

```
src/
├── data/                  Declarative content — no behaviour
│   ├── tools.ts           THE TOOL REGISTRY. See §5.
│   ├── site.ts            Site name, canonical URL, description
│   └── icons.ts           Shared UI icon path data
│
├── lib/                   Pure logic. NEVER touches the DOM. See §4.
│   ├── random.ts          CSPRNG primitives: randomInt, pick, sample, shuffle
│   ├── charsets.ts        Character classes, ambiguous-glyph filter
│   ├── password.ts        generatePassword + option validation
│   ├── passphrase.ts      generatePassphrase + wordlist metadata
│   ├── entropy.ts         Bits, strength tiers, crack-time phrasing
│   ├── base64.ts          UTF-8-safe encode/decode, standard and URL-safe
│   ├── md5.ts             Hand-written MD5 — WebCrypto will not do it
│   ├── hash.ts            MD5 + SHA-256/512 over bytes
│   ├── format.ts          Shared result type, line/column, deep key sort
│   ├── jsonfmt.ts         Format/minify/sort + engine-independent locator
│   ├── yamlfmt.ts         Tidy YAML, convert to/from JSON (lazy js-yaml)
│   ├── clipboard.ts       Copy, with a non-secure-context fallback
│   ├── ui.ts              DOM helpers. See §4.
│   ├── textio.ts          DOM wiring for the two-pane text tools. See §4.
│   └── wordlists/         BIP39, superhero and EFF short as string modules
│
├── layouts/
│   ├── BaseLayout.astro   <head>, SEO, theme no-flash script, header/footer
│   └── ToolLayout.astro   BaseLayout + breadcrumb, title, privacy badge,
│                          JSON-LD, "more tools" footer
│
├── components/            Presentational. No tool-specific logic.
│   ├── Header.astro       Nav generated from the registry
│   ├── Footer.astro
│   ├── ThemeToggle.astro  Self-contained: markup + style + script
│   ├── Icon.astro         Renders 24×24 stroked SVG from path data
│   ├── ToolCard.astro     Home page / "more tools" card
│   ├── RangeField.astro   Slider + typed number box + step buttons
│   ├── OutputPanel.astro  Result box + copy + regenerate + strength meter
│   ├── BulkPanel.astro    Count, generate, copy-all, download, per-row copy
│   └── IoPanel.astro      Input/output textareas for the text tools
│
├── pages/
│   ├── index.astro        Grid generated from the registry
│   ├── about.astro        How it works, where randomness comes from
│   ├── privacy.astro      What is stored (theme + settings) and what is not
│   ├── 404.astro
│   ├── sitemap.xml.ts     Generated from the registry
│   ├── robots.txt.ts      Generated, so the sitemap URL follows the domain
│   └── tools/
│       ├── password-generator.astro
│       ├── passphrase-generator.astro
│       ├── base64.astro
│       ├── hash-generator.astro
│       ├── json-formatter.astro
│       └── yaml-formatter.astro
│
└── styles/global.css      Design tokens, light + dark, all component styles
```

Rough scale: 1447 lines of logic in `lib/`, 575 of components and layouts, 1522 of pages, 1240 of
CSS, 594 of verification. The wordlist modules are generated and excluded from that count.

---

## 4. The layering rule

There are three layers, and exactly one rule that matters:

```
  data/        declarative      registry, site metadata, icon paths
    ↓
  lib/         pure functions   NO DOM ACCESS
    ↓
  pages/       wiring           reads the form, calls lib/, writes the DOM
  components/
```

**`src/lib/` never touches the DOM.** Every module there is plain functions over plain values.

That is what makes `scripts/verify.ts` possible: it imports the same modules the browser runs and
exercises them in Node, with no jsdom and no browser harness. Statistical properties like RNG
uniformity need hundreds of thousands of iterations to test meaningfully, which is only practical
because there is no DOM in the way.

**Two files in `lib/` are exceptions**, both DOM-only by nature: `ui.ts` (`el`, `attachCopy`,
`renderStrength`, `attachBulk`, `bindStepper`, `loadPrefs`) and `textio.ts`, which wires the
two-pane text tools. They live in `lib/` because several pages import them, not because they fit
the rule. They are deliberately the only files there that do, and the verification scripts import
neither.

The page `<script>` blocks are thin: read the form into an options object, hand it to a `lib/`
function, write the result into the markup. They contain no generation logic and no arithmetic.

---

## 5. The tool registry

`src/data/tools.ts` is the single source of truth for what this site contains.

```ts
interface Tool {
  slug: string;         // URL segment and page filename
  name: string;
  tagline: string;      // one line, shown on the card
  description: string;  // full sentence, becomes <meta name="description">
  keywords: readonly string[];
  icon: string;         // inner markup of a 24×24 stroked SVG
  status: 'live' | 'planned';
}
```

Everything derives from it:

| Consumer | Uses |
|---|---|
| `pages/index.astro` | `LIVE_TOOLS` for the primary grid, `PLANNED_TOOLS` for the roadmap |
| `components/Header.astro` | `LIVE_TOOLS` for nav links, with `aria-current` on the active one |
| `layouts/ToolLayout.astro` | `toolBySlug` for the h1, description, JSON-LD; the rest for "more tools" |
| `pages/sitemap.xml.ts` | `LIVE_TOOLS` only — planned tools never reach the sitemap |

`status: 'planned'` renders a dimmed, dashed, non-clickable card and is excluded from nav and
sitemap. It exists so the roadmap is visible without shipping a dead link.

**Adding a tool:**

1. Add an entry to `TOOLS` with `status: 'live'`.
2. Create `src/pages/tools/<slug>.astro` wrapped in `<ToolLayout slug="<slug>">`.
3. Put non-trivial logic in `src/lib/<tool>.ts` as pure functions.
4. Add checks to `scripts/verify.ts`.

Nothing else needs editing. The home page, nav, sitemap and cross-links pick it up.

---

## 6. Feature catalogue

### 6.1 Password generator — `/tools/password-generator/`

| Control | Range / options | Default |
|---|---|---|
| Length | 6 – 128 — slider, typed box, or ± buttons | 20 |
| Character types | lowercase (26), uppercase (26), digits (10), symbols (28) | **all four** |
| At least one of each type | on / off | on |
| Exclude ambiguous glyphs | on / off | off |
| No repeated characters | on / off | off |
| Bulk count | 1 – 100 | 10 |

- Full pool is 90 characters; excluding ambiguous glyphs reduces it to 70.
- Live pool size is shown under the length slider, so the effect of each toggle is visible.
- Regenerates on every option change, plus an explicit **Regenerate** button.
- Invalid combinations are explained rather than thrown — "Without repeats the pool of 70
  characters caps the length at 70", "Length must be at least 4 to fit one of each selected type".
- Bulk panel: generate N, copy all, download `.txt`, copy any single row.

### 6.2 Passphrase generator — `/tools/passphrase-generator/`

| Control | Range / options | Default |
|---|---|---|
| Word count | 3 – 15 — slider, typed box, or ± buttons | 6 |
| Wordlists | BIP39 English (2,048), Superheroes (101), EFF Short (1,296) — **any combination** | **BIP39 + Superheroes** |
| Separator | hyphen, dot, underscore, space, none, random digit, random symbol, **custom** | hyphen |
| Custom separator | any text, capped at 8 characters | `-` |
| Capitalisation | lowercase, Title Case, UPPERCASE, one random word uppercase | lowercase |
| Append a digit | on / off | **on** |
| Append a symbol | on / off | off |
| Bulk count | 1 – 50 | 10 |

- **Lists combine.** Ticking several draws from the union of all of them. Merged pools are cached
  by the exact set that produced them, so toggling a list on and off costs one merge.
- **Merging deduplicates, and that is correctness rather than tidiness.** The lists overlap
  heavily — 464 words are in both BIP39 and the EFF short list; all three together hold 2,967
  distinct words out of 3,445 raw entries. A plain concatenation would do two wrong things at
  once: report `log2(3,445)` bits for a pool that does not have that many distinct words (0.22
  bits per word too many), and make every shared word twice as likely to be drawn as an unshared
  one. The hint under the slider names the pool size and says how many words were shared.
- Combining buys less than it looks: all three lists together are 11.54 bits per word against 11
  for BIP39 alone. The pool is what matters, and pools grow logarithmically.
- Wordlists load via dynamic `import()`, so the password page pays for none of them and a visitor
  who never ticks a list never downloads it. Loaded lists are cached per page view.
- The custom separator row is revealed only when the separator select is set to Custom. A typed
  separator is part of the scheme, not a secret, so it contributes **zero** bits — stated on the
  page itself rather than left for the user to assume.
- The shipped default — BIP39 + superheroes, 2,140 distinct words, 6 words plus a digit — is
  **69.7 bits**, which the meter reports as *Fair*. The superhero list alone would be 43.3 bits and
  *Weak*; pairing it with BIP39 is what keeps a memorable default from being a bad one.
- The digit and the symbol land on two *different* words when both are requested.
- Separator and suffix symbol alphabets are separate sets (§8.2).

### 6.3 Base64 encoder & decoder — `/tools/base64/`

| Control | Options | Default |
|---|---|---|
| Direction | Encode / Decode | Encode |
| Alphabet | standard / URL-safe (`base64url`) | standard |

- **UTF-8, not Latin-1.** `btoa` throws on `"café"` and corrupts anything above U+00FF, so text
  goes through `TextEncoder` first. Emoji, Vietnamese, Arabic and CJK all round-trip.
- **Decoding is liberal on input, strict on output.** Whitespace is stripped, both alphabets are
  accepted regardless of the toggle, and padding is restored — Base64 arrives wrapped at 76
  columns and unpadded often enough that rejecting it would make the tool useless. A character
  outside the alphabet, or a length that cannot form complete groups, is still reported.
- Decoding uses `TextDecoder` with `fatal: true`, so binary payloads produce *"the bytes are not
  valid UTF-8"* rather than a screen of replacement characters.

### 6.4 Hash generator — `/tools/hash-generator/`

| Control | Options | Default |
|---|---|---|
| Input | text area, or a local file | text |
| Case | lowercase / uppercase hex | lowercase |

- **All three digests at once** — MD5, SHA-256, SHA-512. A checksum you are handed rarely says
  which algorithm produced it, and digest length identifies it: 32 hex characters, 64, or 128.
- SHA comes from `crypto.subtle`. **MD5 is hand-written** (`lib/md5.ts`) because WebCrypto
  deliberately refuses to implement it. The page says plainly that MD5 is broken and fit only for
  non-adversarial checksums.
- Files are read with `File.arrayBuffer()` and hashed in the page. Typing into the textarea takes
  over from a loaded file rather than being silently ignored.
- Results are tagged with a generation counter: a slower digest from an earlier keystroke cannot
  overwrite a newer one.

### 6.5 JSON formatter — `/tools/json-formatter/`

| Control | Options | Default |
|---|---|---|
| Output | Pretty / Minify | Pretty |
| Indent | 2 spaces, 4 spaces, tab | 2 |
| Sort object keys | on / off | off |

- **Errors are located, not quoted.** See §8.4 — the position is found by bisection over
  `JSON.parse`, not by scraping the engine's message.
- Sorting is recursive over objects. **Array order is never touched**: in JSON an array's order is
  data, so reordering it would change the document rather than reformat it.
- Minify reports how many characters it saved.

### 6.6 YAML formatter — `/tools/yaml-formatter/`

| Control | Options | Default |
|---|---|---|
| Mode | Tidy YAML / YAML → JSON / JSON → YAML | Tidy YAML |
| Indent | 2 or 4 spaces | 2 |
| Sort mapping keys | on / off | off |

- Pane labels, the placeholder and the Sample button all follow the mode, so *Sample* never loads
  JSON into a YAML parse.
- **Reformatting is lossy and the page says so.** The document is parsed to data and printed
  fresh, so comments, blank lines and quoting style do not survive; anchors and aliases are
  expanded rather than preserved. A check in the suite asserts that comments are dropped, so the
  documented behaviour cannot drift silently.
- `loadAll`, not `load`: a `---` stream is read in full. Tidy mode re-emits every document; YAML →
  JSON yields an array.
- js-yaml is imported on demand and cached, so the parser is fetched once, only on this page.

### 6.7 Shared tool chrome

The generators share `OutputPanel`, `BulkPanel` and `RangeField`; the four text tools share
`IoPanel` and `lib/textio.ts`:

- **Numeric fields** — every count control offers three ways in: drag the slider, type an exact
  value, or step by one with the ± buttons. The range input stays canonical; `bindStepper` mirrors
  it into the number box. While typing, the box is followed only once it holds a legal value —
  clamping on every keystroke would rewrite `1` to the minimum before the user reached `12`.
  Correction of an empty or out-of-range box happens on blur or Enter.

- **Output box** — monospace, `user-select: all`, wraps on any character so a long result never
  scrolls the page sideways.
- **Strength meter** — five segments, coloured by tier, plus the raw bit count and an average
  brute-force time. Tiers: Very weak `<36`, Weak `<56`, Fair `<72`, Strong `<96`, Excellent `≥96`.
- **Copy** — `navigator.clipboard` with a `execCommand` fallback for non-secure contexts, a
  transient "Copied" label, and an ARIA live region so the flash is announced.
- **Bulk panel** — count, generate, copy all, download `.txt`, per-row copy.
- **Error line** — `role="alert"`, used for impossible option combinations.
- **Text panes** — input and output textareas side by side above 820px, stacked below; a
  character/byte/line count under each; Copy, Save, Clear, Sample, and *Use as input* to feed a
  result back. Transforms are debounced at 140 ms and tagged with a generation counter, so an
  async result (the first YAML parse, which waits on an import) can never overwrite a newer one.
- **Settings persistence** — every control is saved to `localStorage` (`tt-password`,
  `tt-passphrase-v3`, `tt-base64`, `tt-hash`, `tt-json`, `tt-yaml`) and restored on the next visit. Output is never stored. A stored value naming
  a wordlist or separator we no longer ship falls back to the default instead of blanking the
  select. **Changing a default means bumping the key**: `loadPrefs` merges defaults under the saved
  object, so returning visitors would otherwise keep the old default forever.

### 6.8 Site-wide

- **Theme** — light / dark / system, cycled by one header button, stored as `tt-theme`. A
  synchronous inline script in `<head>` applies it before first paint, so a dark-theme visitor
  never sees a white flash.
- **Pages** — home, about, privacy, 404, two tools.
- **SEO** — per-page title, description, canonical URL, Open Graph and Twitter card tags,
  `WebApplication` JSON-LD on tool pages, generated `sitemap.xml` and `robots.txt`.
- **Prefetch** — Astro prefetches links on hover.
- **Accessibility** — semantic landmarks, `aria-current` on the active nav item, visible focus
  rings, `prefers-reduced-motion` honoured, live region for copy feedback.
- **Responsive** — single fluid grid, controls reflow to one column on narrow screens.

---

## 7. Design system

`src/styles/global.css` defines every colour as a custom property. Light is the base; the dark
values are overridden twice — under `@media (prefers-color-scheme: dark)` guarded by
`:root:not([data-theme="light"])`, and under `:root[data-theme="dark"]`.

The duplication is deliberate. It is what lets an explicit choice win in both directions: someone
whose OS is dark can still force this site light, and vice versa. A single media query cannot do
that.

Consequence to respect: **never give a colour its only definition inside a media or `[data-theme]`
block.** Every token must exist on bare `:root` first.

Class naming is loose BEM (`.tool-card__name`, `.tool-card--planned`). The home page grid has two
variants — `--primary` for shipped tools (wider cards, larger mark) and `--secondary` for the
roadmap (denser, quieter) — so the two groups do not compete for attention.

---

## 8. Security and correctness decisions

### 8.1 Randomness

All random values come from `crypto.getRandomValues()`. `Math.random()` is never used: its internal
state is recoverable from a handful of outputs, which would make anything derived from it
predictable.

`randomInt(max)` uses **rejection sampling**, not `% max`. The naive modulo is biased whenever
`max` does not divide 2³² evenly — the leftovers of the final partial block make small results
marginally more likely. Draws landing in that block are discarded and retried, costing less than
one extra draw on average.

Passwords with "at least one of each type" are built in two stages — one mandatory character per
class, then free filler — and then **shuffled**. Without the shuffle every password would start
with a lowercase character, handing an attacker free information. `verify.ts` asserts this: over
4,000 draws the first character is lowercase roughly as often as lowercase occupies the pool
(26/90 ≈ 29%), rather than 100%.

### 8.2 Separator vs suffix symbols

`SEPARATOR_SYMBOLS` (13 characters) is drawn between words. `SUFFIX_SYMBOLS` (9) is drawn for the
"append a symbol" extra and deliberately excludes `-`, `_`, `=` and `^` — every character that can
also act as a separator. Otherwise an appended symbol could sit flush against a matching separator
and read as one token (`word--next`), which is confusing to type and to dictate.

This split was found by the verification suite, not by review.

### 8.3 What "entropy" means here

The number shown measures **the generator, not the string**: the size of the space an attacker
searches assuming they know every setting on the page. That is the honest assumption, and it is
why pattern-matching scorers like zxcvbn are not used — they answer "how guessable is this text",
which understates a genuinely random output.

Where a choice is ambiguous the count is **deliberately conservative**:

- The random *position* of an appended digit or symbol in a passphrase is real entropy. It is not
  counted.
- Crack time assumes 10¹¹ guesses/second — an offline attack on a fast hash with commodity GPUs —
  and reports the average case, half the keyspace.

One known over-estimate, documented on the page itself: **"at least one of each type" narrows the
space slightly** compared with a free draw, so the reported bits are a fraction of a bit high at
typical lengths.

### 8.4 Locating a JSON error

`JSON.parse` tells you *what* is wrong; where it went wrong is engine-specific and moves between
versions. Current V8 uses two formats — one with `at position N`, one with only a quoted snippet —
Firefox reports `line L column C` in its own words, and the wording has changed before.

So the position is not read from the message at all. `findErrorIndex` bisects on a predicate every
engine agrees with: **did the parser consume the whole prefix and simply want more input?** That is
true when the prefix parses, or when the reported offset is at the prefix's end. The largest prefix
satisfying it ends exactly at the first character the parser cannot accept.

The cost is O(log n) parses of an O(n) prefix; above 2 MB the tool falls back to the engine's own
message rather than spending the time. The engine's wording is still used for the *reason*, with
its position clause stripped so the message does not state the location twice.

This was found the honest way: the first implementation scraped `at position N`, and a check in the
suite failed against the V8 build in use. Seven exact offsets are now pinned in `verify-tools.ts`.

### 8.5 Headers

`vercel.json` sets CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`,
`X-Frame-Options: DENY` and a restrictive `Permissions-Policy`, plus immutable caching for hashed
assets.

`script-src` allows `'unsafe-inline'` for one reason: the theme script must run synchronously in
`<head>` before first paint, and moving it to a file would cost a blocking round trip. The site
renders no user input and loads no third-party script, so the practical XSS surface is nil. A
hash-based CSP was considered and rejected — it would break silently the moment anyone edited that
script. `style-src` needs `'unsafe-inline'` for Astro's scoped styles and a few inline `style`
attributes.

---

## 9. Verification

```bash
npm run verify   # 145 checks, Node, no browser
npm run check    # astro check — TypeScript across .astro and .ts
npm run build    # runs check first, then the static build
```

`scripts/verify.ts` imports the same `lib/` modules the browser runs and asserts:

- **RNG uniformity** — 600,000 draws of `randomInt(6)` stay within 2% of expectation;
  120,000 shuffles place a given element uniformly.
- **Shipped defaults** — that the passphrase tool really does default to the superhero list with a
  digit appended, printing the resulting bit count so a weak default cannot go unnoticed.
- **Structural properties** — length, character-class membership, the shuffle actually shuffling,
  no-repeats producing distinct characters, ambiguous glyphs fully removed.
- **Option validation** — every impossible combination is rejected with a message.
- **Wordlist integrity** — 2,048, 1,296 and 101 entries, all unique, no whitespace, and the
  registry's advertised size matching the list actually loaded.
- **Passphrase composition** — word count, separators, capitalisation modes, digit and symbol
  landing on different words, suffix symbols never colliding with separators, custom separators
  used verbatim and capped in length.
- **MD5** — the seven RFC 1321 vectors, then `node:crypto` as an oracle at **every input length
  from 0 to 200 bytes** (55/56/57 and 63/64/65 are where a hand-written MD5 usually breaks) and on
  a 3 MB buffer, which exercises the 64-bit length field.
- **SHA** — published vectors for SHA-256 and SHA-512, UTF-8 handling, and that hashing a
  `subarray` view digests its own bytes rather than the whole backing buffer.
- **Base64** — ASCII and non-ASCII round-trips, agreement with Node's Base64, URL-safe output and
  cross-alphabet decoding, tolerance of wrapping and missing padding, rejection of invalid input,
  and that binary payloads are reported rather than turned into mojibake.
- **JSON** — pretty/minify/sort/tab output, seven pinned error offsets (§8.4), that array order
  survives sorting, and that JSON5-isms (trailing commas, unquoted keys, comments) are rejected.
- **YAML** — all three modes, indent and sort options, multi-document streams, error location, and
  two documented behaviours asserted so they cannot drift: comments are dropped by reformatting,
  and unquoted `NO` stays a string under the 1.2 core schema.
- **Merging** — that the union drops duplicates, equals sum minus overlap, loses no source word,
  invents none, is order-stable across calls, and is unchanged by passing a list twice. BIP39 is
  additionally checked for its defining property: 2,048 words unique in their first four letters.
- **Shipped pool sizes** — the default pool is 2,140 words and all three ticked is 2,967, asserted
  as literals so adding or dropping a list cannot quietly change the entropy the page reports.

**Structural passphrase assertions draw from BIP39, deliberately.** They split a phrase on its
separator to count words, and the EFF short list ships a hyphenated entry (`yo-yo`) that breaks
that assumption. BIP39 contains no punctuation at all, so the assertion tests the generator rather
than the list. A dedicated check pins the hyphenated entry so the quirk stays on record.
- **Registry accuracy** — the `size` advertised beside each wordlist matches the list actually
  loaded, so the bits-per-word note can never describe the wrong list.
- **Entropy arithmetic** — exact bit values for known configurations, tier boundaries, and
  crack-time formatting at both extremes.

Run it after touching anything in `src/lib/`.

The build output is also checked statically: every DOM hook the page scripts query is asserted to
exist in the built HTML, and the HTML is scanned for third-party origins — the mechanical version
of the privacy claim in §1.

---

## 10. Build and deploy

`astro build` emits `dist/` with directory-format URLs (`/tools/password-generator/index.html`),
so clean URLs need no server rules.

Bundle sizes as built (gzip in brackets):

| Asset | Size | Loaded by |
|---|---|---|
| CSS | 17.2 KB (4.0 KB) | every page |
| Theme + prefetch | 2.4 KB (1.1 KB) | every page |
| Shared DOM helpers | 8.8 KB (3.8 KB) | tool pages |
| Text-tool wiring | 2.0 KB (0.9 KB) | the four text tools |
| Password page script | 3.2 KB (1.5 KB) | password page |
| Passphrase page script | 3.0 KB (1.4 KB) | passphrase page |
| Base64 page script | 1.7 KB (1.0 KB) | Base64 page |
| Hash page script | 3.3 KB (1.6 KB) | hash page |
| JSON page script | 2.1 KB (1.1 KB) | JSON page |
| YAML page script | 2.6 KB (1.3 KB) | YAML page |
| Superhero wordlist | 0.8 KB (0.5 KB) | passphrase page, on demand |
| EFF short wordlist | 7.1 KB (3.3 KB) | passphrase page, on demand |
| BIP39 wordlist | 12.8 KB (6.2 KB) | passphrase page, on demand |
| js-yaml | 58.2 KB (17.4 KB) | YAML page, on demand |

A tool page is about 6 KB of gzipped JavaScript before the wordlist.

Vercel needs no configuration beyond `vercel.json`, which pins the build command, output
directory, headers and caching. **Set `SITE_URL`** once a custom domain is attached — it feeds
canonical tags, the sitemap and `robots.txt`. Without it the build falls back to Vercel's
production URL, then to the placeholder in `src/data/site.ts`.

---

## 11. Known gaps

Honest list, in rough order of how much they matter:

1. **The shipped passphrase default is only *Fair*.** BIP39 + superheroes at six words plus a digit
   is 69.7 bits, two bits short of the *Strong* tier and about 152 years against the offline model
   in §8.3. Good enough for most accounts, not for a password manager's master password. Raising
   the default word count to 7 would clear 80 bits; a `recommendedWords` field per wordlist would
   let the word count follow the pool automatically, which is the better fix now that the pool
   varies with what the user ticks.
2. **No browser-level test.** Verification covers logic in Node and DOM hooks in the built HTML,
   but nothing has ever driven the actual page. A smoke test with Playwright — load each tool,
   click regenerate, assert the output changed — would close the gap.
3. **`entropy.ts` imports from `passphrase.ts`** for the symbol alphabets, which pulls passphrase
   code into the password page's shared chunk. Small, but a real coupling; moving the symbol
   constants into their own module would break it.
4. **No `modulepreload` for the shared chunk**, so it is a second round trip after the page
   script. Irrelevant at 3.8 KB, worth revisiting if it grows.
5. **The text panes have no syntax highlighting or line numbers.** For formatters whose error
   messages name a line, a plain textarea makes the reader count. An editor component would be the
   single heaviest asset on the site, so this stays a deliberate trade rather than an oversight.
6. **Reformatting YAML drops comments.** Inherent to parse-and-print; the page warns and a check
   pins the behaviour, but preserving them would need a CST-based emitter that js-yaml does not
   offer.
7. **CSP allows `'unsafe-inline'` for scripts.** Reasoning in §8.5; the tradeoff is deliberate,
   not an oversight.
8. **No internationalisation.** The UI is English-only, with no structure in place for anything
   else.
9. **A hyphenated word in the EFF short list.** `yo-yo` collides with the hyphen separator, so
   such a phrase cannot be split back into its words unambiguously. Entropy is unaffected and the
   word is EFF's own, so nothing is filtered; it is recorded here because it surfaced as a flaky
   test before it was understood.
10. **Planned tools are registry entries only.** The UUID and JWT tools have cards and nothing
    behind them.
