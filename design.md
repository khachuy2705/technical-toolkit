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
| Styling | Hand-written CSS, custom properties | ~1400 lines total. A utility framework would ship more bytes than the entire site. |
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
│   ├── i18n.ts            Chrome strings in English and Vietnamese. See §5.
│   ├── site.ts            Site name, canonical URL, description
│   └── icons.ts           Shared UI icon path data
│
├── lib/                   Pure logic. NEVER touches the DOM. See §4.
│   ├── random.ts          CSPRNG primitives: randomInt, pick, sample, shuffle
│   ├── charsets.ts        Character classes, ambiguous-glyph filter
│   ├── password.ts        generatePassword + option validation
│   ├── passphrase.ts      generatePassphrase + wordlist metadata
│   ├── entropy.ts         Bits, strength tiers, crack-time phrasing
│   ├── ipv4.ts            Address parsing and subnet arithmetic
│   ├── ipv6.ts            IPv6 parsing, RFC 5952 text, types, ip6.arpa (bigint)
│   ├── iprange.ts         Range→CIDR, aggregate, supernet, split — both families
│   ├── epoch.ts           Unix time parsing, civil-date maths, zone conversion
│   ├── lunar.ts           Vietnamese lunar calendar, Can Chi
│   ├── base64.ts          UTF-8-safe encode/decode, standard and URL-safe
│   ├── md5.ts             Hand-written MD5 — WebCrypto will not do it
│   ├── hash.ts            MD5 + SHA-256/512 over bytes
│   ├── format.ts          Shared result type, line/column, deep key sort
│   ├── jsonfmt.ts         Format/minify/sort + engine-independent locator
│   ├── jsonhighlight.ts   Forgiving JSON scanner → highlighted HTML
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
│   ├── Header.astro       Links to the four tool groups on the home page
│   ├── ToolGroupNav.astro Sibling strip at the top of every tool page
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
│   ├── index.astro        One grid per tool group, from the registry
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
│       ├── yaml-formatter.astro
│       ├── subnet-calculator.astro
│       ├── ip-range-to-cidr.astro
│       ├── cidr-aggregator.astro
│       ├── cidr-splitter.astro
│       ├── ipv6-calculator.astro
│       ├── epoch-converter.astro
│       └── lunar-calendar.astro
│
└── styles/global.css      Design tokens, light + dark, all component styles
```

Rough scale: 3664 lines of logic in `lib/`, 681 of components and layouts, 4278 of pages, 1877 of
CSS, 1563 of verification. The wordlist modules are generated and excluded from that count.

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
  group: 'network' | 'security' | 'data' | 'time';
  vi: { name: string; tagline: string; description?: string };  // see "Page language" below
}
```

`TOOL_GROUPS` fixes the order and the display names (English and Vietnamese) of the four groups.

Everything derives from it:

| Consumer | Uses |
|---|---|
| `pages/index.astro` | `TOOL_GROUPS` + `liveToolsIn` for one grid per group, `PLANNED_TOOLS` for the roadmap |
| `components/Header.astro` | `TOOL_GROUPS` for four links to `/#<group>` |
| `components/ToolGroupNav.astro` | `liveToolsIn(tool.group)` for the sibling strip |
| `layouts/ToolLayout.astro` | `toolBySlug` for the h1, description, JSON-LD; the rest for "more tools", same group first |
| `pages/sitemap.xml.ts` | `LIVE_TOOLS` only — planned tools never reach the sitemap |

`status: 'planned'` renders a dimmed, dashed, non-clickable card and is excluded from nav and
sitemap. It exists so the roadmap is visible without shipping a dead link.

**Adding a tool:**

1. Add an entry to `TOOLS` with `status: 'live'` and a `group`. Entries within a group appear in
   registry order, so place it where it should sit among its siblings.
2. Create `src/pages/tools/<slug>.astro` wrapped in `<ToolLayout slug="<slug>">`.
3. Put non-trivial logic in `src/lib/<tool>.ts` as pure functions.
4. Add checks to `scripts/verify.ts`.

Nothing else needs editing. The home page, nav, sitemap and cross-links pick it up. Give the
entry a `vi` name and tagline too — the Vietnamese page lists every tool in its nav and footer.

### Tool groups

Thirteen tools do not fit in a header, and a flat grid of them buries related tools among
unrelated ones. So every tool belongs to one of four groups — **Network**, **Security**,
**Data formats**, **Date & time** — and the group is what the navigation is built from:

- **Home page** — one titled section per group (`id="network"` and so on), in `TOOL_GROUPS`
  order. Sections carry `scroll-margin-top` so the sticky header does not cover a heading
  reached by anchor.
- **Header** — four links, one per group, to `/#<group>`. This was chosen over per-group
  dropdown menus: it needs no script, works the same on every page, and the home page already
  is the grouped menu. Hidden below 660px, like the tool links it replaced.
- **Sibling strip** — `ToolGroupNav` sits between the breadcrumb and the title of every tool
  page and lists the live tools of that page's group, the current one filled with the accent.
  The group name at its start links back to the group's section. It renders nothing for a group
  of one, and scrolls sideways within itself when a group is wider than the screen.
- **More tools** — the cards at the foot of a tool page list same-group tools first.

The network group is where this matters most: the subnet calculator, range converter,
aggregator, splitter and IPv6 calculator are five pages that people use in sequence.

### Page language

The site is English. A page can opt into Vietnamese by passing `lang="vi"` to `ToolLayout` (or
`BaseLayout`), and everything the layout draws follows: `<html lang>`, the header nav (tool names
come from each registry entry's `vi` block via `toolText`), the footer, the breadcrumb, the privacy
badge, the "more tools" cards, the theme toggle's labels, and the JSON-LD `inLanguage`. The chrome
strings live in `src/data/i18n.ts`. The copy buttons' "Copied" feedback is chosen in `lib/ui.ts`
from `<html lang>`, so it needs no wiring per page.

Only the lunar calendar uses it today (§6.13). The page content itself is written directly in the
page; there is no message catalogue, because no page exists in two languages. The brand name,
*Technical Toolkit*, stays as it is in both.

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
- **Syntax colouring in both panes, as you type.** Keys, strings, numbers, `true`/`false`/`null`
  and punctuation each have a colour; anything JSON does not allow — a comment, a bare word, a
  quote that never closes — is red before the formatter even runs. After a failed parse, the
  exact character the error message names is marked in the input.

  It is a layer, not an editor. `lib/jsonhighlight.ts` is a forgiving scanner (never throws; every
  character lands in exactly one token) that returns an HTML string. `IoPanel highlight` puts a
  `<pre>` behind each textarea; the textarea's text is transparent and its caret is not, so typing,
  selection, copy, undo and resizing are all the browser's own. The layer carries the same
  `.io__text` class, so font, padding, border and wrapping match by construction, and both reserve
  the scrollbar gutter so a scrollbar appearing in one cannot re-wrap only that one. Scrolling is
  mirrored on the textarea's `scroll` event.

  The input layer repaints on every keystroke rather than after the debounce — its text is
  invisible otherwise — so documents over 200,000 characters (about 25 ms to colour) fall back to
  plain text. The suite fuzzes the one invariant that matters: with the tags stripped, the layer's
  text is exactly the textarea's, over 3,000 generated inputs. A browser run over the DevTools
  protocol confirmed the two layers overlap glyph for glyph, including wrapped lines, accented text
  and emoji, and after scrolling. Base64 and YAML use the same panel without the layer and are
  unchanged.

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

### 6.7 Subnet calculator — `/tools/subnet-calculator/`

*The first of five network tools; §6.8–§6.11 are its siblings, and all five share the sibling
strip described in §5.*

One text field, everything derived from it as you type. Accepts `10.0.0.1/24`,
`10.0.0.1/255.255.255.0`, a space instead of the slash, or a bare address (taken as `/32`, and the
page says so rather than silently assuming).

**Network (CIDR)** leads: `10.144.141.83/26` in, `10.144.141.64/26` out. That canonical form —
network address with the host bits cleared, prefix attached — is what goes into a route table or a
firewall rule, and it is the value most likely to be copied. The four the tool was originally asked
for follow and share the accent colour: CIDR prefix, subnet mask, network address, first usable
host. Then broadcast, last usable host, usable and total counts, wildcard mask and address type,
because a subnet calculator missing those is half a tool.

Three details that separate a correct calculator from a plausible one:

- **`>>> 0` on every bitwise result.** JavaScript's bitwise operators work on signed int32, so
  every address from 128.0.0.0 up comes back negative without it. A check pins `255.255.255.255`
  at 4294967295.
- **/31 and /32 are special-cased.** RFC 3021 made both addresses of a /31 usable — point-to-point
  links need two, and spending a /30 on them wasted half the space — and a /32 is a single host.
  The usual "total minus network and broadcast" gives 0 and −1 usable hosts for these, which is
  what calculators that skip the special case report.
- **Leading zeros are refused, not guessed.** `010.0.0.1` is octal 8 to `inet_aton` and decimal 10
  to others, and that disagreement is a well-worn allow-list bypass. Non-contiguous masks
  (`255.255.0.255`) are refused for the same reason: a plausible-looking answer would be worse
  than an error.

Address classification covers RFC 1918 private space, loopback, link-local, CGNAT, the three
documentation ranges, multicast, reserved and limited broadcast, matched most-specific-first.

Below the results sits a **cheat sheet**: /32 down to /1 against their subnet mask, wildcard mask,
total addresses and usable hosts, with a copy button on every mask. Descending order is how these
tables are read — you start from the host count you need. `/0` is left out, being the default route
rather than a subnet anyone sizes.

It is generated at build time from the same `describeNetwork` the calculator runs, not typed out,
so the table and the tool cannot disagree — and the `/31` and `/32` rows come out as 2 and 1 usable
hosts rather than the 0 and −1 that printed cheat sheets tend to carry. All 33 mask strings are
pinned in the suite (the lib covers /0 even where the table does not), because a regression there
would publish a wrong reference table to every visitor. The table is the one element allowed to
scroll sideways; the page body is not.

### 6.8 IP range to CIDR — `/tools/ip-range-to-cidr/`

One range per line in, the fewest CIDR blocks that cover each range exactly out. Ends are separated
by a spaced hyphen, an en dash or `to`; a bare hyphen is accepted for IPv4 only, where it cannot be
mistaken for part of the address. A line holding one address or one CIDR is its own range, and
`#` starts a comment. IPv4 and IPv6 can share the input.

| Control | Options | Default |
|---|---|---|
| Write each block as | CIDR / address + mask / ACL wildcard | CIDR |
| Separate blocks with | new line / comma | new line |

Masks and wildcards are IPv4 notions, so IPv6 blocks stay prefixes whatever the style. The output
note counts ranges, blocks and addresses. A bad line fails the whole transform with its line
number, because a partial block list for a firewall is worse than none.

**Minimality is proved, not assumed.** `rangeToCidrs` is greedy from the low end: each block is as
large as the start address's alignment allows without passing the end. The suite checks all
32,896 ranges inside a /24 against a dynamic-programming optimum, and asserts for each that the
blocks tile the range with no gap, no overlap and no misaligned block.

### 6.9 CIDR aggregator / supernet — `/tools/cidr-aggregator/`

A list of prefixes in, one of two summaries out:

- **Aggregate** — lossless. Duplicate, contained, overlapping and adjacent prefixes merge into the
  fewest blocks covering exactly the same addresses. Implemented as merge-intervals followed by
  range-to-CIDR on each merged interval, so it inherits §6.8's minimality.
- **Supernet** — the single shortest prefix containing every input, per address family. The page
  states how many addresses it covers that no input did, as a count and a percentage, because
  that surplus is exactly what makes a summary route attract traffic it cannot deliver.

The input is forgiving and the page says what it forgave. Entries may be separated by new lines,
commas, semicolons or spaces; `10.0.0.0 255.255.255.0` is one entry because a token joins its
predecessor only when it is a whole, valid dotted mask (checking just the first octet would glue
`192.168.0.0/16` onto the entry before it). Commas and semicolons always separate. A report card
below the panes lists unreadable entries with their line, prefixes whose host bits were cleared
(`192.168.1.77/24 → 192.168.1.0/24`), duplicates, and prefixes already inside another — each list
capped at 50 with a count of the rest. Up to 10,000 entries are read.

The suite checks that aggregation never changes the address set and is idempotent, over 400
random lists compared address by address in a bitmap.

### 6.10 CIDR splitter — `/tools/cidr-splitter/`

A parent network and either a number of subnets or a prefix length in; every subnet out, with its
first and last address and usable-host count. A count that is not a power of two rounds up, and
the hint says how many spares that creates. IPv4 usable hosts lose network and broadcast except on
/31 and /32; IPv6 counts every address.

Splits get large fast — a /8 into /32s is 16,777,216 rows, a /48 into /64s is 65,536 — so the
count shown is always the true total, the table draws the first 1,024 rows (in its own scrolling
box with a sticky header), and *Copy list* and *CSV* carry the first 65,536. Both limits are
exported from `lib/iprange.ts` so the page text and the code cannot disagree. Each mode remembers
its own number, so switching between *count* and *prefix* does not lose what was typed.

**VLSM was scoped out** at the planning stage (§12): the page does equal splits only.

### 6.11 IPv6 calculator — `/tools/ipv6-calculator/`

The IPv6 counterpart of §6.7, built on `lib/ipv6.ts`, where addresses are 128-bit `bigint`s.
Input accepts every RFC 4291 text form — compressed, full, trailing dotted IPv4, brackets, and a
`%zone`, which is set aside and mentioned. A bare address is /128.

Five facts carry the accent: network in CIDR, prefix length, first address, last address, total
addresses (`2^64`, with the full number underneath when it is long). The rest: the address in
RFC 5952 canonical and expanded form, the mask, how many /64s fit, the address type, embedded
IPv4, EUI-64 MAC, the full `ip6.arpa` name and the reverse zone for the prefix. A wide card shows
the network in binary, and a build-time table lists prefix sizes from /128 to /16 with their /64
counts and typical uses.

- **Canonical text is RFC 5952 exactly**: lowercase, no leading zeros, the longest run of two or
  more zero groups compressed (the first on a tie), a lone zero group left alone, and
  IPv4-mapped addresses printed with a dotted quad. The RFC's own examples are pinned, and 2,000
  generated values round-trip through both the canonical and the expanded form.
- **Types are matched most-specific-first** over 15 rules: unspecified, loopback, IPv4-mapped,
  NAT64 and local NAT64, discard, Teredo, ORCHIDv2, both documentation ranges (2001:db8::/32 and
  RFC 9637's 3fff::/20), 6to4, unique local, link-local, multicast and global unicast.
- **Embedded IPv4** is read where the type defines it: last 32 bits for IPv4-mapped and NAT64,
  bits 16–47 for 6to4, and the inverted last 32 bits for a Teredo client — pinned with RFC 4380's
  own example.
- **EUI-64** — when the interface ID has the `ff:fe` marker, the MAC is recovered with the
  universal/local bit flipped back, and the note says that this identifier exposes the hardware.
- **Reverse DNS** — the 32-nibble name is pinned against RFC 3596's example. A zone exists only
  on a nibble boundary, so for a /49 the page gives the /48 zone and says to delegate eight /52s.
- **No "minus two"** — IPv6 has no broadcast. The first address is noted as the subnet-router
  anycast address.

### 6.12 Epoch converter — `/tools/epoch-converter/`

One field that takes whatever a log line hands you: a bare epoch number in seconds, milliseconds,
microseconds or nanoseconds, a fractional one like `1758086602.123`, ISO 8601, or the
`2026-09-17 14:03:22` form a SQL console prints. Everything below it recomputes as you type.

A ticking strip above the input shows the current time in seconds, milliseconds and ISO 8601, each
with a copy button and a **Use this** button that drops it into the field — "what is the epoch
right now" is half of why the page gets opened.

Five values carry the accent: Unix seconds, Unix milliseconds, ISO 8601 UTC, your local time, and
the same instant in whichever zone you pick. Then the supporting detail: relative to now, weekday,
day of year, ISO week, microseconds, nanoseconds, and the UTC log form. Below that, two reference
tables generated at build time from the same formatter the converter runs — landmark timestamps
(the epoch itself, both 32-bit overflows, the database ceiling) and common intervals in seconds
(DNS TTLs, session timeouts, certificate lifetimes).

Directly under the clock, a **Quick convert** card holds two single-purpose boxes side by side: a
date-and-time picker that answers with the epoch, and an epoch box that answers with the date and
weekday. They share one time-zone selector, which **always opens on the browser's own zone** and is
deliberately not saved between visits, so "what is this in my time" never depends on a choice made
last week. The full inspector below keeps its own, remembered, zone.

Going from a wall clock to an instant is the direction that needs care, because a wall time does
not always name exactly one instant. `wallTimeToMs` tries the zone's offset from a day before and
a day after, and keeps each only if the zone agrees it was in force at the result:

- one survivor — the normal case;
- two — the hour repeated when clocks went back (1 November 2026, 01:30 in New York happens twice);
  the earlier instant is used and the later one is shown in the note;
- none — the time was skipped when clocks went forward (8 March 2026, 02:30 in New York never
  happened); it is pushed forward by the length of the gap.

That is the resolution Temporal's default `"compatible"` mode uses, and the page states which case
it hit in an amber note rather than returning a number that looks certain. The offset itself is
derived from the wall clock, not parsed from ICU's `GMT+07:00` label, because local mean time
carries seconds — Saigon was +07:06:30 until 1906 — and the label rounds them away.

The picker is a native `datetime-local` with `step="1"`, so seconds are included. Typed wall times
are range-checked field by field: `2023-02-29` and `24:00` are refused, where `Date` would roll them
into the next day without a word.

Four decisions carry the inspector:

- **Nanoseconds are a `bigint`, not a number.** A 19-digit nanosecond timestamp is past
  `Number.MAX_SAFE_INTEGER`, so a converter that parses one into a double hands it back changed by
  a couple of hundred nanoseconds. A check pins an exact round trip and asserts that the same
  value through `Number()` really would have been wrong, so the reason for the `bigint` cannot be
  optimised away by someone who does not know it. The decimal point is shifted by string
  concatenation for the same reason: `1699999999.123456 * 1e9` is not an integer in binary
  floating point.

- **Calendar maths avoids `Date` entirely.** `daysFromCivil`/`civilFromDays` — Howard Hinnant's
  pair — are pure, exact for every proleptic Gregorian year, and free of the two-digit-year trap
  where `Date.UTC(99, 0, 1)` means 1999. They round-trip every day across 800 years in the suite.
  Everything calendar-shaped is built on them: weekday, day of year, and the ISO week number,
  which has to report its own week-numbering year because 1 January 2021 is week 53 of **2020**.

- **The unit of a bare number is a guess, and it is labelled as one.** Ten digits is seconds,
  thirteen milliseconds, sixteen microseconds, nineteen nanoseconds — those being where a
  present-day timestamp sits in each unit — and the lengths in between round down to the coarser
  one, because that is the reading that lands in a plausible year. The line above the input always
  says which unit it chose and why, and five buttons override it.

- **Ambiguous date strings are refused rather than guessed.** `Date.parse` is far more willing
  than it looks: V8 reads `1.2.3` as 2 January 2003 and `09/17/2026` by American convention, and
  other engines disagree. So a string with no letters in it has to carry the ISO calendar shape the
  specification actually defines; a version string, a partial IP address or a slash-separated date
  gets a named error instead of a silent reinterpretation. Strings with letters — `17 Sep 2026`,
  the RFC 2822 form in an Apache log — still parse, because a spelled-out month is not ambiguous.
  This is the same stance as the subnet calculator's refusal of leading zeros in §6.7.

One asymmetry is surfaced rather than smoothed over, because it is a real JavaScript trap:
`2026-09-17` alone is read as **midnight UTC**, while `2026-09-17T00:00:00` is read in your **local
zone**. That is what the ECMAScript specification requires, so the page states which reading you
got rather than pretending the two are the same.

Time zones come from `Intl.supportedValuesOf("timeZone")` at runtime, not baked at build time — it
is the visitor's browser that has to be able to format them, and a fallback list covers the
runtimes that will not answer. Historical offsets are honoured because the zone database carries
them: a check pins `1970-01-01` in `Asia/Ho_Chi_Minh` at **+08:00**, which is what Saigon ran on
before 1975, precisely because "apply the current offset to every date" is the shortcut that makes
a converter wrong about anything historical.

### 6.13 Lunar calendar converter — `/tools/lunar-calendar/`

**The page is entirely in Vietnamese** — content, chrome, notes and error messages — because the
calendar and the people who look dates up in it are. `lib/lunar.ts` therefore throws its refusals
as `LunarError` with Vietnamese messages, and the page shows only those verbatim; anything else
that throws becomes a generic Vietnamese sentence rather than an English engine message.

Converts between the Vietnamese lunisolar calendar (âm lịch) and the Gregorian one, following
Hồ Ngọc Đức's published algorithm
([Thuật toán tính âm lịch](https://www.xemamlich.uhm.vn/calrules.html)). Two boxes side by side
— a date picker that answers with the lunar date, and day / month / year / leap fields that answer
with the solar date — both opening on today by the browser's clock. Each lunar result is also
spelled the way it is said aloud (*Mùng 7 tháng Tám năm Bính Ngọ*) and carries the Can Chi names
of its day, month and year. Below them, every month of a chosen lunar year with its start date and
length, and a build-time table of Tết dates for the years around now.

The astronomy — truncated series for the new moon and the sun's longitude — is the article's,
reimplemented rather than copied. Five departures from its sample code are deliberate:

- **Day 30 of a 29-day month is refused.** The sample turns it into the first day of the next
  month without a word.
- **A leap flag must name the real leap month.** The sample ignores the flag in a common year.
  On the page, the leap checkbox is disabled for every month but the year's leap month.
- **The month containing a date is found by search.** The sample estimates it from the mean
  lunation and steps back at most once; near some boundaries that is a whole month off, and it
  reports "day 0" (7 May 2054 is one).
- **A leap month after month 12 is numbered 12.** The sample computes `leapOff - 2` and only wraps
  negatives, so it would call it month 0. None occurs in range, so the check is on the numbering
  function directly.
- **Lunar years before 1968 are computed for UTC+8.** North Vietnam moved the calendar to UTC+7
  from lunar year 1968; before that the calendar in use followed the UTC+8 computation. A single
  meridian throughout would convert 1950s birthdays against a calendar nobody printed. The last
  month of 1967 is cut where Tết 1968 begins, so the two periods join exactly.

**How it was checked.** The author also publishes a table-driven version of his calendar
(`amlich-hnd.js`, precomputed with his full-precision program for 1800–2199). Its licence allows
personal, non-commercial use only, so **it is not in this repository** — not the file and not the
tables. It was used once, locally, as an oracle. Result over 1900–2199: 99.64% of days agree,
every leap month agrees, lunar→solar→lunar round-trips on every day, and 1968–2053 agrees
exactly. The rest are thirteen single month boundaries where the new moon falls within minutes of
midnight and the simplified series cannot tell which side: 1906, 1914, 1916, 1920, 1925, 2054,
2072, 2077, 2130, 2150, 2159, 2175, 2199. The page lists them. Before 1900 the table follows
older, pre-modern calendar rules and the agreement collapses, which is why the range starts there.

The suite pins only independent facts: Tết dates from public record, leap months, the article's
own 2004 example, the 1968 and 1985 Hanoi/Beijing splits, the 2033 leap month 11, Can Chi of known
days (Tết 2024 was a Giáp Thìn day, month and year), and a round trip over all 109,573 days of
the range.

### 6.14 Shared tool chrome

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
- **Privacy badge** — under every tool title: “Runs entirely in your browser. Nothing you enter is
  sent anywhere.” It used to say “Generated locally with your browser's crypto API” on every
  tool, which was only ever true of the two generators.
- **Text panes** — input and output textareas side by side above 820px, stacked below; a
  character/byte/line count under each; Copy, Save, Clear, Sample, and *Use as input* to feed a
  result back. Height starts at 15rem and is per-tool: `IoPanel` takes a `minHeight` prop that
  sets `--io-min-height`, which the JSON formatter doubles to 30rem because its documents run long.
  Both panes stay user-resizable regardless. Transforms are debounced at 140 ms and tagged with a
  generation counter, so an async result (the first YAML parse, which waits on an import) can
  never overwrite a newer one. An `onEmpty` hook lets a page clear anything it drew outside the
  panes — the aggregator's report — when the input is emptied, since the transform does not run
  then.
- **Settings persistence** — every control is saved to `localStorage` (`tt-password`,
  `tt-passphrase-v3`, `tt-base64`, `tt-hash`, `tt-json`, `tt-yaml`, `tt-subnet`, `tt-range`,
  `tt-aggregate`, `tt-split`, `tt-ipv6`, `tt-epoch`) and restored on the next visit. Output is never stored. A stored value naming
  a wordlist or separator we no longer ship falls back to the default instead of blanking the
  select. **Changing a default means bumping the key**: `loadPrefs` merges defaults under the saved
  object, so returning visitors would otherwise keep the old default forever.

### 6.15 Site-wide

- **Theme** — light / dark / system, cycled by one header button, stored as `tt-theme`. A
  synchronous inline script in `<head>` applies it before first paint, so a dark-theme visitor
  never sees a white flash.
- **Pages** — home, about, privacy, 404, and thirteen tools in four groups (§5, *Tool groups*).
- **Navigation** — header links to the four groups; a sibling strip on every tool page.
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
npm run verify   # 497 checks, Node, no browser
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
- **IPv4** — parsing and rejection (malformed octets, leading zeros, non-contiguous masks), the
  full /0–/32 mask table pinned as literals because the page publishes it, seven host-to-subnet
  conversions with the canonical form asserted idempotent, every prefix round-tripping through its
  mask, five worked networks checked field by field, the /31 and
  /32 special cases, that usable hosts never go negative at any prefix, that high addresses stay
  unsigned, and eleven address-type classifications.
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
- **Epoch exactness** — a 19-digit nanosecond value round-trips unchanged, and the check also
  asserts that the same value through `Number()` would have been wrong, so the reason for the
  `bigint` stays on record. Fractional and negative epochs are pinned too, because every division
  below 1970 has to floor rather than truncate toward zero.
- **Civil-date arithmetic** — `daysFromCivil` and `civilFromDays` are asserted to be exact
  inverses for every day across 800 years, which is what the weekday, day-of-year and ISO week
  results rest on. Week numbering is pinned at the cases that catch naive implementations:
  2021-01-01 is 2020-W53, 2019-12-30 is 2020-W01.
- **Date-string policy** — that `1.2.3`, `09/17/2026` and `10.0.0.1` are refused *by name*, while
  `Thu, 17 Sep 2026 14:03:22 GMT` still parses.
- **Zone rendering** — a fixed offset, a half-hour offset, both sides of a daylight-saving
  transition in `America/New_York`, one instant falling on two different dates in Tokyo and Los
  Angeles, and a historical offset the current one would get wrong.
- **Wall time to epoch** — the New York spring-forward gap and fall-back overlap, Lord Howe
  Island's thirty-minute shift, Saigon's +07:06:30 local mean time, impossible dates refused, and
  a round trip from instant to wall time and back in six zones every 7h13m across three years.
- **Lunar calendar** — Tết dates, leap months and Can Chi against public record, the Hanoi/Beijing
  splits of 1968 and 1985, the 1967/1968 era join, every refusal by name, and a solar→lunar→solar
  round trip over every day from 1900 to 2199 (about 0.4 s).
- **JSON highlighting** — tokens tile every input with no gap or overlap and the layer's text
  equals the textarea's (fuzzed over 3,000 inputs), key/string classification, markup escaping,
  and where the error mark lands.
- **IPv6** — RFC 5952 and RFC 3596 examples, 13 malformed inputs refused, 2,000 round trips,
  every address type, embedded IPv4 including Teredo's inversion, EUI-64, masks and counts.
- **Range to CIDR** — all 32,896 ranges in a /24 against a DP optimum; every accepted separator;
  refusals by name (reversed, mixed family, three ends).
- **Aggregate and supernet** — known merges, 400 random lists checked address by address for an
  unchanged set and idempotence, supernet surplus counts, list parsing (masks after a space,
  commas as hard separators, host bits, line-numbered problems, the entry limit).
- **Split** — equal splits, rounding up, the /8-into-/32 and /48-into-/64 counts with truncation,
  refusals.
- **Published reference data** — the nine landmark timestamps and the 33 subnet masks are pinned
  in full, because both tables are rendered at build time and a regression would hand every
  visitor a wrong reference.

Run it after touching anything in `src/lib/`.

**Browser runs.** Since the JSON highlighting work, each UI change has also been driven in
headless Chrome over the DevTools protocol — type into the page, read the DOM, take screenshots,
collect uncaught exceptions. The scripts are throwaway and not in the repository; §11 gap 2 is
about making that permanent.

---

## 10. Build and deploy

`astro build` emits `dist/` with directory-format URLs (`/tools/password-generator/index.html`),
so clean URLs need no server rules.

Bundle sizes as built (gzip in brackets):

| Asset | Size | Loaded by |
|---|---|---|
| CSS | 25.3 KB (5.4 KB) | every page |
| Theme + prefetch | 2.4 KB (1.1 KB) | every page |
| Shared DOM helpers | 8.8 KB (3.8 KB) | tool pages |
| Text-tool wiring | 2.0 KB (0.9 KB) | the four text tools |
| Password page script | 3.2 KB (1.5 KB) | password page |
| Passphrase page script | 3.0 KB (1.4 KB) | passphrase page |
| Base64 page script | 1.7 KB (1.0 KB) | Base64 page |
| Hash page script | 3.3 KB (1.6 KB) | hash page |
| JSON page script | 3.7 KB (1.9 KB) | JSON page, highlighting included |
| YAML page script | 2.6 KB (1.3 KB) | YAML page |
| Epoch page script | 11.6 KB (4.8 KB) | epoch page |
| Lunar page script | 7.7 KB (3.6 KB) | lunar calendar page |
| IPv6 library | 5.3 KB (2.4 KB) | IPv6 page and the three range tools |
| Range library | 4.9 KB (2.1 KB) | range, aggregator and splitter pages |
| Range / aggregator / splitter / IPv6 page scripts | 1.1 / 3.0 / 3.4 / 2.7 KB | their pages |
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
2. **No browser-level test, and no audit of the built HTML.** Verification covers `lib/` in Node
   and nothing else. Nothing has ever driven the actual page, and nothing checks that the DOM
   hooks each page script queries are present in the built output — `el()` throws on a missing
   selector, so a renamed `id` would break a tool silently until someone opened it. Two separate
   fixes: a static pass over `dist/` asserting every queried hook exists and no third-party origin
   is loaded (cheap, and it would mechanise the privacy claim in §1), and a Playwright smoke test
   (the real fix). *An earlier revision of this document claimed the static pass already existed.
   It does not, and never did.*
3. **`entropy.ts` imports from `passphrase.ts`** for the symbol alphabets, which pulls passphrase
   code into the password page's shared chunk. Small, but a real coupling; moving the symbol
   constants into their own module would break it.
4. **No `modulepreload` for the shared chunk**, so it is a second round trip after the page
   script. Irrelevant at 3.8 KB, worth revisiting if it grows.
5. **Only the JSON panes are coloured, and none has line numbers.** The YAML formatter's panes
   are plain, and every error message still names a line the reader has to count to. Both fit the
   same layer technique (§6.5); YAML needs a tokenizer that understands indentation, and line
   numbers need a gutter that follows wrapped lines.
6. **Reformatting YAML drops comments.** Inherent to parse-and-print; the page warns and a check
   pins the behaviour, but preserving them would need a CST-based emitter that js-yaml does not
   offer.
7. **CSP allows `'unsafe-inline'` for scripts.** Reasoning in §8.5; the tradeoff is deliberate,
   not an oversight.
8. **Localisation is one page deep.** The chrome can render in Vietnamese (§5, *Page language*),
   but only the lunar calendar page does, and its nav and footer link to pages that are English.
   There is no language switcher and no second-language version of any page.
9. **A hyphenated word in the EFF short list.** `yo-yo` collides with the hyphen separator, so
   such a phrase cannot be split back into its words unambiguously. Entropy is unaffected and the
   word is EFF's own, so nothing is filtered; it is recorded here because it surfaced as a flaky
   test before it was understood.
10. **Two address models live side by side.** `ipv4.ts` works on 32-bit numbers and powers the
    subnet calculator; `iprange.ts` works on `bigint` for both families and powers the newer
    tools. They agree — `iprange` parses IPv4 through `ipv4.ts` — but the subnet calculator could
    move onto the shared model, which would also let it accept IPv6 and retire the separate page.
    Not done, because the IPv4 page's /31, broadcast and classful presentation does not carry over.
11. **The epoch converter leans on the browser for two things.** Zone rendering comes from
    `Intl`, so the answer is only as current as the visitor's tz database — a device that has not
    been updated since a country last moved its clocks will render recent dates in that zone
    wrongly, and the page has no way to know. Separately, date strings containing letters still go
    through `Date.parse`, which is implementation-defined beyond ISO 8601; the letterless cases are
    refused outright (§6.12) but `"Sept 17 2026"` may parse in one engine and not another.
12. **The lunar calendar inherits the article's precision.** Thirteen month boundaries in
    1900–2199 land a day off the author's full-precision tables (§6.13), four of them in this
    century's second half. A fuller new-moon series (Meeus ch. 49) would likely close them, at the
    cost of no longer being the algorithm the page cites. South Vietnam's 1968–1975 calendar, which
    stayed on UTC+8, is not modelled.
13. **Planned tools are registry entries only.** The UUID and JWT tools have cards and nothing
    behind them.

---

## 12. Roadmap and ideas

A running record of what was decided, what is done, and what is next. Newest decisions first.

### Decisions on the network group

Asked and answered before building §6.8–§6.11:

| Question | Decision |
|---|---|
| One page with modes, or separate tools? | Separate pages in a **Network** group, with a sibling strip |
| Header: dropdown menus per group, or links? | **Four links** to the grouped sections of the home page |
| UI language for the new tools | **English**, like every page but the lunar calendar |
| VLSM (allocate by host counts) in the splitter? | **No** — equal splits only |
| IPv6 in the range, aggregator and splitter tools now or later? | **Now** — one `bigint` implementation serves both families |

### Done

| Area | What |
|---|---|
| Generators | Password and passphrase generators, entropy readout, bulk mode |
| Data formats | Base64, hash (MD5/SHA-256/SHA-512), JSON with syntax highlighting, YAML |
| Network | Subnet calculator with cheat sheet and canonical CIDR, IP range to CIDR, CIDR aggregator/supernet, CIDR splitter, IPv6 calculator |
| Date & time | Epoch converter with two-way quick convert and DST-aware wall time; Vietnamese lunar calendar |
| Site | Tool groups on the home page, group links in the header, sibling strip, Vietnamese chrome for the lunar page |

### In progress

Nothing is half-built. Every tool in the registry marked `live` is complete and verified; the two
`planned` entries have no code yet.

### Next, in rough order

1. **Make the browser checks permanent** (gap 2): a static audit of `dist/` for DOM hooks and
   third-party origins, then a Playwright smoke test per tool.
2. **UUID generator** (planned card): v4 from `crypto.randomUUID`, v7 with a millisecond
   timestamp, bulk mode reusing `BulkPanel`, and a decoder that reads the version and v7 time.
3. **JWT decoder** (planned card): header and payload pretty-printed with the JSON highlighter,
   `exp`/`iat`/`nbf` rendered through `epoch.ts`, and a clear statement that the signature is not
   verified — verification needs a key the page should never ask for.
4. **Passphrase default** (gap 1): per-wordlist recommended word counts so the default reaches
   *Strong*.
5. **YAML highlighting and line numbers** (gap 5), on the same layer technique as JSON.

### Ideas not yet scheduled

Collected while planning; all fit the static, nothing-leaves-the-browser constraint in §1.

- **Cron expression explainer** — plain-English reading and the next run times; systemd
  `OnCalendar` too.
- **chmod / umask calculator** — octal ↔ `rwx` ↔ symbolic, with setuid/setgid/sticky.
- **Regex tester** — JavaScript dialect, stated as such; matches, named groups, replacement preview.
- **Certificate / CSR decoder** — PEM in, subject, SANs, validity, key and fingerprints out;
  fingerprints reuse `hash.ts`, the ASN.1 parser is the real work.
- **MAC address tool** — format normalisation, EUI-64, U/L and multicast bits, and an OUI vendor
  lookup (the one idea with a sizeable dataset, ~300 KB lazy-loaded).
- **URL parser and encoder**, **data size and transfer-time calculator**, **HMAC** (a small
  extension of the hash tool), **TOTP code generator**, **config format converter**
  (JSON ↔ YAML ↔ TOML ↔ `.env`).
- **IPv6 in the subnet calculator** — see gap 10.

Deliberately out of scope: anything that needs a server or a third-party API — ping, traceroute,
DNS lookups, whois, port scans, checking a live site's certificate. Each would break the promise in
§1, and the privacy page says so in as many words.
