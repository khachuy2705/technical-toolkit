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
│   ├── random.ts          CSPRNG primitives: randomInt, pick, sample, shuffle,
│   │                      distinctIndices
│   ├── charsets.ts        Character classes, ambiguous-glyph filter
│   ├── password.ts        generatePassword + option validation
│   ├── passphrase.ts      generatePassphrase + wordlist metadata
│   ├── username.ts        Usernames from hero names: case, spacing, digits
│   ├── entropy.ts         Bits, strength tiers, crack-time phrasing
│   ├── ipv4.ts            Address parsing and subnet arithmetic
│   ├── ipv6.ts            IPv6 parsing, RFC 5952 text, types, ip6.arpa (bigint)
│   ├── iprange.ts         Range→CIDR, aggregate, supernet, split — both families
│   ├── epoch.ts           Unix time parsing, civil-date maths, zone conversion
│   ├── lunar.ts           Vietnamese lunar calendar, Can Chi
│   ├── txcode.ts          Transaction codes: year + day of year → a date
│   ├── cron.ts            Crontab: parse, describe (EN/VI), next runs across DST, builder
│   ├── oncalendar.ts      systemd OnCalendar=: parse and normalize as systemd 259 does,
│   │                      describe (EN/VI), next elapses with systemd's own mistakes
│   ├── timespan.ts        systemd time spans (5min, 1h 30min), parsed and printed exactly
│   ├── unitfile.ts        systemd unit files: conf-parser, every value parser, the
│   │                      unit-wide rules, and advice — each finding in EN and VI
│   ├── unitdirectives.ts  GENERATED from systemd's own table: every directive and how its
│   │                      value is read. See scripts/unit-directives.ts
│   ├── unitdocs.ts        One sentence per common directive, in EN and VI
│   ├── bytes.ts           Sizes and rates as exact fractions: SI/IEC/bit units, numbers
│   │                      and units as people type them, transfer time, one-line questions
│   ├── unicode.ts         Grapheme-safe homoglyph substitution and change records
│   ├── escape.ts          \uXXXX, \u{…} and \xNN escapes, decode and encode
│   ├── base64.ts          UTF-8-safe encode/decode, standard and URL-safe
│   ├── md5.ts             Hand-written MD5 — WebCrypto will not do it
│   ├── hash.ts            MD5 + SHA-256/512 over bytes
│   ├── asn1.ts            DER encoder and reader — the floor under X.509
│   ├── pem.ts             PEM encode/decode, forgiving about pasted text
│   ├── keys.ts            WebCrypto key generation, import, signing
│   ├── x509.ts            DN, SANs, purposes, certificate and CSR builders
│   ├── pkcs12.ts          .p12 — PBES2 for the key, the RFC 7292 KDF for the MAC
│   ├── jks.ts             .jks — Sun's legacy Java keystore
│   ├── certgen.ts         Ties those together: one form in, one bundle out
│   ├── openssl.ts         The same form, as a script you could have run instead
│   ├── format.ts          Shared result type, line/column, deep key sort
│   ├── jsonfmt.ts         Format/minify/sort + engine-independent locator
│   ├── jsonhighlight.ts   Forgiving JSON scanner → highlighted HTML
│   ├── yamlfmt.ts         Tidy YAML, convert to/from JSON (lazy js-yaml)
│   ├── clipboard.ts       Copy, with a non-secure-context fallback
│   ├── ui.ts              DOM helpers. See §4.
│   ├── textio.ts          DOM wiring for the two-pane text tools. See §4.
│   ├── lang.ts            DOM: the language switch of a bilingual page. See §4, §5.
│   └── wordlists/         BIP39, superhero and tarot as string modules;
│                          heroes.ts, Marvel and DC names by word
│
├── layouts/
│   ├── BaseLayout.astro   <head>, SEO, theme no-flash script, header/footer
│   └── ToolLayout.astro   BaseLayout + breadcrumb, title, privacy badge,
│                          JSON-LD, "more tools" footer; a `head` slot
│                          under the title for a page's own section links
│
├── components/            Presentational. No tool-specific logic.
│   ├── Header.astro       Links to the six tool groups on the home page
│   ├── ToolGroupNav.astro Sibling strip at the top of every tool page
│   ├── Footer.astro
│   ├── ThemeToggle.astro  Self-contained: markup + style + script
│   ├── Say.astro          One string in both languages, for bilingual pages (§5)
│   ├── LangSwitch.astro   English / Tiếng Việt radios under a bilingual page's title
│   ├── Icon.astro         Renders 24×24 stroked SVG from path data
│   ├── ToolCard.astro     Home page / "more tools" card
│   ├── RangeField.astro   Slider + typed number box + step buttons
│   ├── OutputPanel.astro  Result box + copy + regenerate + optional strength meter
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
│       ├── username-generator.astro
│       ├── unicode-spoofer.astro
│       ├── base64.astro
│       ├── hash-generator.astro
│       ├── json-formatter.astro
│       ├── yaml-formatter.astro
│       ├── certificate-generator.astro
│       ├── subnet-calculator.astro
│       ├── ip-range-to-cidr.astro
│       ├── cidr-aggregator.astro
│       ├── cidr-splitter.astro
│       ├── ipv6-calculator.astro
│       ├── epoch-converter.astro
│       ├── lunar-calendar.astro
│       ├── transaction-code-decoder.astro
│       ├── crontab-generator.astro
│       ├── systemd-oncalendar.astro
│       ├── systemd-unit-analyzer.astro
│       └── byte-converter.astro
│
└── styles/global.css      Design tokens, light + dark, all component styles

scripts/
├── verify.ts              The harness: runs every check below, owns the exit code
├── verify-tools.ts, verify-cron.ts, verify-cert.ts
├── verify-systemd.ts      OnCalendar, against systemd-analyze where it can be run
├── verify-units.ts        Unit files and time spans, against systemd-analyze verify
├── verify-bytes.ts        The byte and throughput converter
└── unit-directives.ts     Writes src/lib/unitdirectives.ts from systemd's gperf table
```

Rough scale: 15,668 lines in `lib/`, 834 of components and layouts, 10,372 of pages, 3,091 of
CSS, 6,000 of verification and generators. The wordlist modules are generated and excluded from
that count; `unitdirectives.ts` is generated too but small. Two features dominate `lib/`: the
certificate stack (`asn1` through `certgen`, about 2,500 lines, and the reason §8.6 exists) and
the systemd pair, `oncalendar.ts` and `unitfile.ts`, about 5,100 — most of it ports of systemd's
own parsers, which is what lets §9 hold them to systemd line for line.

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

**Three files in `lib/` are exceptions**, all DOM-only by nature: `ui.ts` (`el`, `attachCopy`,
`renderStrength`, `attachBulk`, `bindStepper`, `loadPrefs`), `textio.ts`, which wires the
two-pane text tools, and `lang.ts`, which switches a bilingual page between its two languages.
They live in `lib/` because several pages import them, not because they fit the rule. They are
deliberately the only files there that do, and the verification scripts import none of them.

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
  group: 'network' | 'security' | 'data' | 'time' | 'system' | 'other';
  bilingual?: boolean;  // the page is written in English and Vietnamese, with a switch
  vi: { name: string; tagline: string; description?: string };  // see "Page language" below
}
```

`TOOL_GROUPS` fixes the order and the display names (English and Vietnamese) of the six groups.

Everything derives from it:

| Consumer | Uses |
|---|---|
| `pages/index.astro` | `TOOL_GROUPS` + `liveToolsIn` for one grid per group, `PLANNED_TOOLS` for the roadmap |
| `components/Header.astro` | `TOOL_GROUPS` for one link per group, to `/#<group>` |
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

Twenty-two tools do not fit in a header, and a flat grid of them buries related tools among
unrelated ones. So every tool belongs to one of six groups — **Network**, **Security**,
**Data formats**, **Date & time**, **System**, **Other** — and the group is what the navigation
is built from. **System** holds the three tools for the machines things run on: the crontab
generator, which moved there from Date & time, and the two systemd tools beside it.

- **Home page** — one titled section per group (`id="network"` and so on), in `TOOL_GROUPS`
  order. Sections carry `scroll-margin-top` so the sticky header does not cover a heading
  reached by anchor.
- **Header** — one link per group, to `/#<group>`. This was chosen over per-group
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

The lunar calendar uses it (§6.13). The brand name, *Technical Toolkit*, stays as it is in both.

**Bilingual pages.** A page can also be written in both languages at once — `lang="both"`, the
default for a registry entry marked `bilingual: true`. The systemd OnCalendar explainer, the unit
file analyzer and the byte converter are. Every string is rendered twice, side by side, by
`Say.astro`: `<span data-l="en">…</span><span data-l="vi">…</span>`; two CSS rules hide the
language not chosen, keyed on `data-lang` on `<html>`. Attributes that cannot hold two strings —
`placeholder`, `aria-label`, `title` — carry both as `data-en-*` and `data-vi-*` and are swapped by
`lib/lang.ts`. What a page script draws is built in the chosen language and redrawn when it
changes (`onLangChange`).

- **Which language first.** An inline script in `<head>`, before first paint, takes `?lang=` if
  present, then the reader's earlier choice, then the browser's language — Vietnamese for `vi`,
  English otherwise — so there is no flash of the other language and no server involved.
- **The switch** is a pair of radios under the title (`LangSwitch.astro`). A choice made there is
  the only one remembered (`tt-lang`); a language inferred from the browser is not written down.
- **Both languages are in the HTML**, so search engines index both, and the prose and tables
  still read without script — in English, since only the script can choose. The cost is a page
  about a third heavier in HTML, which is cheap next to its script.
- **Chrome follows the page**: header, footer, breadcrumb, sibling strip, more-tools cards, privacy
  badge and theme toggle all render both languages on a bilingual page. Tool pages that are not
  bilingual are untouched.

Prose is written for each language rather than translated word for word; the two versions of a
sentence say the same thing, and the checks (§9) assert that every finding and note the
analyzers produce has both, and that the two differ.

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
| Wordlists | BIP39 English (2,048), Superheroes (101), Tarot cards (78) — **any combination** | **BIP39 + Superheroes** |
| Separator | hyphen, dot, underscore, space, none, random digit, random symbol, **custom** | hyphen |
| Custom separator | any text, capped at 8 characters | `-` |
| Capitalisation | lowercase, Title Case, UPPERCASE, one random word uppercase | lowercase |
| Append a digit | on / off | **on** |
| Append a symbol | on / off | off |
| Bulk count | 1 – 50 | 10 |

- **Lists combine.** Ticking several draws from the union of all of them. Merged pools are cached
  by the exact set that produced them, so toggling a list on and off costs one merge.
- **Merging deduplicates, and that is correctness rather than tidiness.** 9 superhero names are
  also BIP39 words, so the default pool holds 2,140 distinct words, not 2,149. A plain
  concatenation would do two wrong things at once: report bits for a pool that does not have
  that many distinct words, and make every shared word twice as likely to be drawn as an
  unshared one. The hint under the slider names the pool size, its bits per word, and how many
  words were shared. The tarot list shares none.
- Combining buys less than it looks: all three lists together are 2,218 words, 11.12 bits per
  word against 11 for BIP39 alone. The pool is what matters, and pools grow logarithmically.
- **Tarot names are one entry each.** The list stores all 78 cards as `the_fool`,
  `ace_of_cups`; `innerJoiner` swaps the `_` for `-` when the phrase separator (fixed or custom)
  contains an underscore, so a card still reads as one unit — `the_fool-ace_of_cups` under the
  default hyphen, `the-fool_ace-of-cups` under underscores. It is derived from the settings, so
  it adds no entropy. A random-symbol separator can still draw `_` or `-` next to a card.
- **No strength meter.** The page passes `strength={false}` to `OutputPanel`: no tier label, no
  total bit count, no crack time. The bits per word stay in the hint under the slider, and the
  prose explains how to multiply them out.
- Wordlists load via dynamic `import()`, so the password page pays for none of them and a visitor
  who never ticks a list never downloads it. Loaded lists are cached per page view.
- The custom separator row is revealed only when the separator select is set to Custom. A typed
  separator is part of the scheme, not a secret, so it contributes **zero** bits — stated on the
  page itself rather than left for the user to assume.
- The shipped default — BIP39 + superheroes, 2,140 distinct words, 6 words plus a digit — is
  **69.7 bits**. The superhero list alone would be 43.3 bits; pairing it with BIP39 is what keeps
  a memorable default from being a bad one.
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
- **Open a file instead of pasting.** An *Open file* button beside Sample, and dropping a file
  anywhere on the input pane, both load the file into the input and format it at once. It is
  `IoPanel openFile="…"` — the value is the picker's `accept` filter (`.json`, `.txt`), which is a
  hint only — so another text tool can opt in with one prop. Details:
  - **Encoding by byte-order mark.** `decodeText` in `lib/format.ts` reads UTF-8, and UTF-16 LE/BE
    when the file starts with the matching mark — Windows PowerShell 5.1 writes UTF-16 LE with `>`,
    and read as UTF-8 that is a NUL between every character. The mark is dropped either way.
  - **10 MB cap** (`OPEN_FILE_LIMIT`). A bigger file is refused with its size, and what was in the
    input stays. The reason is written in the input's meta line, beside the button, in the error
    colour and through the live region — not in the error line, which sits below two 30rem panes
    and would be off screen when the button is pressed.
  - **Only file drags are intercepted.** Dragging selected text into the textarea is the
    browser's own. A dashed accent outline marks the textarea while a file is over the pane,
    counted across `dragenter`/`dragleave` so crossing into a child does not flicker it off.
  - **A near miss is refused, not opened.** Inviting a drop makes one land beside the input
    sometimes, and the browser's default for a dropped file is to open it in place of the page,
    losing what was typed. Outside the pane a file drag gets `dropEffect = "none"` and its drop is
    swallowed. Pages without `openFile` do not register the guard.

  Driven in headless Chrome over CDP: the button through an intercepted file chooser (the same
  file twice, UTF-8 with accents, UTF-16 LE, a broken file naming line 3, an 11 MB refusal that
  keeps the typed input), a real drag onto the textarea, out of the pane and onto the output pane
  (`copy` over the input, `none` beside it), and 390px with no sideways scroll. CDP's synthetic
  drop does not trigger the browser's open-the-file navigation even on an unguarded page, so the
  guard was checked by its effect on real `DragEvent`s instead.

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

### 6.14 Certificate & CSR generator — `/tools/certificate-generator/`

One page, three modes, because all three share a CA and a subject form:

| Mode | Signs with | Produces |
|---|---|---|
| **Root CA** | its own new key | a self-signed CA certificate + key |
| **Certificate signed by a CA** | the CA made in this tab, or one pasted in | a leaf certificate + key + chain |
| **Certificate request (CSR)** | its own new key | a PKCS#10 request + key |

The second mode carries a tick box, **this certificate is itself a CA**, which
turns the result into an intermediate. That is what makes the usual two-tier
shape reachable — an offline root that signs one intermediate, and an
intermediate that does the day-to-day issuing — and it is the reason being a CA
is a property of the certificate here rather than of the mode. A CSR can request
it too, for an intermediate to be signed by someone else's root.

| Control | Options | Default |
|---|---|---|
| Subject | CN, O, OU, L, ST, C, emailAddress | — (CN required) |
| Subject alternative names | DNS, IP, email, URI — one per line or comma-separated | — |
| Purpose | TLS server, TLS client, document signing, code signing, S/MIME, timestamping | **TLS server** |
| Key | RSA 2048/3072/4096, ECDSA P-256/P-384/P-521 | RSA 2048 |
| Signature hash | SHA-256/384/512, following the key unless overridden | SHA-256 |
| Validity | days, with 90 / 398 / 825 / 10-year presets | 825 (CA: 3650) |
| Path length | no limit, 0, 1, 2 — whenever a CA is being made | no limit |
| CA private key | pasted, or loaded from a file as PEM or binary DER | — |
| Key passphrase | asked for only when the pasted key is encrypted | — |
| Export | PEM (key, certificate, chain), PKCS#12, JKS | — |

- **SAN kinds are inferred from shape**, not chosen from a dropdown: `@` is an address, `://` a
  URI, dotted digits IPv4, colons IPv6, anything else a host name. A wildcard outside the leftmost
  label is refused by name, as is a malformed host.
- **Purposes drive two extensions.** The ticked set unions into `keyUsage` (critical) and
  `extKeyUsage`. The page shows the resulting extensions live, before anything is generated,
  because the most common failure of a hand-made certificate is a missing EKU.
- **The session CA is memory only.** A CA generated here is held in a module variable so the next
  certificate can be signed immediately; nothing is written to storage and a reload loses it. The
  page says so, and offers a **Sign a certificate with it** button that switches mode in place.
  Persisting CAs is deliberately not built — see §12.
- **A pasted CA is read as it is pasted**, showing its subject, whether it is a CA, and its expiry,
  so a wrong file is obvious before a key is generated against it. The same for the key: the page
  detects an encrypted one and only then asks for a passphrase, so the common case shows no box to
  ignore.
- **Encrypted CA keys are opened in the page**, which matters because most real CA keys are. Two
  forms are handled: PKCS#8 `ENCRYPTED PRIVATE KEY` under PBES2, and OpenSSL's traditional
  `Proc-Type: 4,ENCRYPTED` PEM. The passphrase is used once, in memory, and never stored.
- **A CA promoted to sign carries its whole chain**, so a certificate under an intermediate comes
  out with the root behind it rather than a link that resolves nowhere.
- **The key and certificate are proved to match** before signing, by signing a random probe with
  the pasted key and verifying it with the certificate's public key. Pasting a mismatched pair is
  the most common mistake here and otherwise produces a certificate that fails only in production.
- **Warnings that do not stop generation** are separated from errors: a TLS certificate with no
  SANs, no purpose ticked at all, a leaf that outlives its CA, an issuer not marked `CA:TRUE`.
- **The equivalent OpenSSL script is shown, and it moves as you type.** Every field feeds it:
  the subject, the key algorithm, each ticked purpose, the validity, the keystore alias. It sits
  above the Generate button rather than in the results, because its main use is to be read
  *instead* of pressing the button — a CA key worth protecting should not be pasted into a
  browser, and the tool says so and hands over the commands. The script is POSIX `sh`; the
  extensions reach `openssl x509` through a heredoc, which PowerShell has no equivalent of.
- Only the shape of the form is remembered in `localStorage` — algorithm, validity, ticked
  purposes. No subject, no names, and no key material.

### 6.15 Shared tool chrome

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
  `OutputPanel strength={false}` leaves it out: for output that is not a secret (§6.21), and on
  the passphrase page, which shows bits per word under the slider instead (§6.2).
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
  then. An `openFile` prop adds *Open file* and drop-to-load to the input pane (§6.5); only the
  JSON formatter sets it.
- **Settings persistence** — every control is saved to `localStorage` (`tt-password`,
  `tt-passphrase-v3`, `tt-base64`, `tt-hash`, `tt-json`, `tt-yaml`, `tt-subnet`, `tt-range`,
  `tt-aggregate`, `tt-split`, `tt-ipv6`, `tt-epoch`, `tt-txcode`, `tt-cron`, `tt-username`) and restored on the next visit. Output is never stored. A stored value naming
  a wordlist or separator we no longer ship falls back to the default instead of blanking the
  select. **Changing a default means bumping the key**: `loadPrefs` merges defaults under the saved
  object, so returning visitors would otherwise keep the old default forever.

### 6.16 Site-wide

- **Theme** — light / dark / system, cycled by one header button, stored as `tt-theme`. A
  synchronous inline script in `<head>` applies it before first paint, so a dark-theme visitor
  never sees a white flash.
- **Pages** — home, about, privacy, 404, and twenty-two tools in six groups (§5, *Tool groups*).
- **Navigation** — header links to the six groups; a sibling strip on every tool page.
- **SEO** — per-page title, description, canonical URL, Open Graph and Twitter card tags,
  `WebApplication` JSON-LD on tool pages, generated `sitemap.xml` and `robots.txt`.
- **Prefetch** — Astro prefetches links on hover.
- **Accessibility** — semantic landmarks, `aria-current` on the active nav item, visible focus
  rings, `prefers-reduced-motion` honoured, live region for copy feedback.
- **Responsive** — single fluid grid, controls reflow to one column on narrow screens.

### 6.17 Unicode text spoofer — `/tools/unicode-spoofer/`

Two panes show the original and spoofed text. Four independent options replace supported
ASCII letters with Greek/Cyrillic lookalikes (on by default), substitute five punctuation marks,
replace ordinary spaces with U+2005, and insert U+200B zero-width spaces (all off by default).
The mapping is small and deterministic; this is not a comprehensive Unicode spoof detector.

- `Intl.Segmenter` keeps graphemes intact: accented letters, combining sequences and emoji
  are preserved. Zero-width spaces go only between graphemes, never around line breaks or
  after the last character. Older browsers without Segmenter get a named error.
- An optional separate preview masks unchanged graphemes with `◌` and labels changed spaces.
  Copy and Save always use the complete transformed text, never the masked preview.
- A change table reports one-based input grapheme positions, original/replacement code points
  and change kinds. Insertions are recorded after their input position. It displays the first
  200 changes while the counts and output remain complete.
- Input is limited to 100,000 UTF-16 code units, with an error rather than silent truncation.
- Only the five checkbox preferences are stored (`tt-unicode-spoofer`). Input and output are
  never persisted. All dynamic display text is inserted with `textContent`.
- Checks in `verify-tools.ts` pin mapping code points, option combinations, grapheme and CRLF
  preservation, preview/output separation, insertion boundaries and size limits.

### 6.18 Transaction code date decoder — `/tools/transaction-code-decoder/`

**The page is Vietnamese**, for the same reason the lunar calendar page is (§6.13): the codes are
issued by Vietnamese systems and read by the people those systems bill. `lib/txcode.ts` throws its
refusals as `TxCodeError` with Vietnamese messages, and the page shows only those verbatim.

Reads the date out of a transaction reference whose first five digits are a date:

```
262641267307
├┘└─┘└─────┘
│  │    └── serial, assigned by the issuing system
│  └─────── day 264 of the year
└────────── year 26
```

Day 264 of 2026 is 21 September 2026. The point of the tool is that this is an **ordinal date** —
the day's number within the year, not a day and a month — so it cannot be read off by eye, and the
one thing that makes it hard to do in your head is the leap day: day 60 is 1 March in a common year
and 29 February in a leap one.

| Control | Options | Default |
|---|---|---|
| Code | one code, separators ignored | the worked example |
| Century for the two year digits | 1900–1999, 2000–2099, 2100–2199 | **2000–2099** |
| Reverse lookup | a date → the five digits every code that day begins with | today |
| Sample code length | 5 – 32 digits | 12 |
| Batch | one code per line, up to 500 | — |

- **The code is shown cut into its parts**, each with its meaning underneath, because the whole
  difficulty is that the first five digits are two fields rather than one.
- **The century is a control, not a constant.** Two digits of year cannot distinguish 1998 from
  2098, and nothing inside the code can. The page says so and lets the century be chosen, rather
  than quietly assuming one; `decodeTxCode` takes it as a parameter for the same reason.
- **Day 000 and a day past the year's length are refused by name** — `25366` says that 2025 has
  only 365 days, rather than silently rolling over into 1 January 2026, which is what a naive
  `new Date(year, 0, ordinal)` would do.
- **Separators are stripped, letters are not.** Codes get written down spaced, dotted and dashed,
  so those are ignored; a stray letter is reported with the character named, because it usually
  means a different field was copied.
- **The reverse direction and the decoder are the same arithmetic**, and the suite pins them to
  each other over all 36,525 days of 2000–2099 rather than to fixtures (§9).
- **The generated sample code is labelled as a sample.** Only the first five digits are real; the
  tail is random, and the page says it is for filling a test system or a screenshot, not a
  transaction reference that exists.
- The batch pane decodes a pasted list into a table, with each failed line carrying its own reason
  in place of the date, and a tab-separated copy for pasting into a spreadsheet.
- A build-time table gives the ordinal range of every month in a common and a leap year, generated
  by the same `dayOfYear` the tool runs. February is the only row marked, because it is where the
  two columns part company.
- Only the century and the sample length are stored (`tt-txcode`). No code is ever persisted.

### 6.19 Unicode escape converter — `/tools/unicode-escape/`

Two panes and one direction switch. Decoding turns `"Kh\u00f4ng t\u1ed3n t\u1ea1i"` back into a
sentence; escaping writes any text as ASCII-only escape sequences. `lib/escape.ts` is pure, and
throws `EscapeError` carrying the offset into the caller's own string, which the page renders as a
line and column through `lineColumn` (§8.4 uses the same helper for JSON).

- The decoder reads `\uXXXX`, `\u{XXXXX}` (refused above U+10FFFF), `\xNN`, `\0` and the
  shorthands `\n \r \t \b \f \v \ \" \' \` \/`. `\uXXXX` is decoded as a **code unit**, not a
  code point, which is what joins `\uD83D\uDE00` back into one emoji. `\0` is NUL only when no
  digit follows it — otherwise it is a legacy octal escape this tool does not claim to read.
- `\a` is deliberately **not** a bell. It is one in C and Python but a plain `a` in JavaScript, and
  silently turning `\already` into a control character would be a trap.
- Text outside a sequence is copied through byte for byte, so a config file with a few escapes in
  it decodes without being reformatted around them.
- Two decoder options: dropping one *matching* pair of surrounding quotes (a lone leading quote is
  kept, and an escaped closing quote is not mistaken for the end), and keeping meaningless
  sequences such as `\d` as written. Turning the second off makes the tool strict about what JSON
  actually allows, and reports the first offender with its position.
- Unpaired surrogates are counted and named in the output note. They are legal in a JavaScript
  string but cannot be encoded as UTF-8, so saving or sending one would silently produce U+FFFD —
  usually it means the input was cut in half upstream.
- The encoder escapes everything outside printable ASCII, prefers `\n`-style shorthands for the
  control characters that have them, and offers surrogate pairs or `\u{…}` for astral characters,
  optional quote/backslash escaping and optional wrapping into a complete JSON string.
- Input is capped at 200,000 characters in both directions, with an error rather than truncation.
- Only the six option values are stored (`tt-unicode-escape`); input and output are never
  persisted.
- Checks in `verify-tools.ts` pin the decode of a real Vietnamese payload, surrogate joining,
  quote handling, strict-mode refusals with their offsets, the encoder's output for both styles,
  and a round-trip whose escaped form is also parsed by `JSON.parse` as an oracle.

### 6.20 Crontab generator & explainer — `/tools/crontab-generator/`

Two halves that share a server time zone and a description language:

- **Build** — five field rows (minute, hour, day of month, month, day of week), each with a mode:
  every value, every N from a start, specific values ticked as chips, or a range with an optional
  step. Presets fill all five at once; a time box sets the minute and hour, and a date box sets
  the day and month as well, with a note that cron has no year field, so the date comes round
  every year. An optional command turns the expression into a whole crontab line.
- **Explain** — one expression or a whole file: `crontab -l` output, `/etc/crontab` with its user
  column, `NAME=value` lines, comments and the `@` shorthands. Every line becomes a card — a job
  (sentence, command, field table, notes, next runs), a setting (what `SHELL`, `PATH`, `MAILTO`,
  `CRON_TZ`, `TZ` and the rest do to the jobs below them), or an unreadable line with its number
  and the reason. One bad line does not hide the others. *Edit in builder* loads a job back into
  the top half.

Two links directly under the title — *Generator* and *Explainer* — jump to the two halves, since
the explainer starts well below the fold. They are plain `#builder` and `#explainer` anchors, so
they need no script and the back button returns to the top; `.jump-target` gives both sections a
`scroll-margin-top` so the sticky header does not cover them. They sit in `ToolLayout`'s `head`
slot, which renders nothing on pages that do not fill it.

| Control | Options | Default |
|---|---|---|
| Server time zone | every zone the browser knows | the browser's own |
| Describe schedules in | English / Tiếng Việt | English |
| Field modes | every, every N, specific, range — day of week has no *every N* | `30 8 * * 1-5` |
| Write months and weekdays as names | `mon-fri` instead of `1-5` | off |
| Lines include a user | the `/etc/crontab` and `/etc/cron.d` column | off |

**The page is English; only the description switches.** The sentence under a schedule and the
*Matches* column of its field table can be written in Vietnamese, because the people reading
crontabs on this site's servers often read that more easily. It is a tool option rather than a
page language (§5): notes, errors and chrome stay English, and the two reference tables carry
both languages and show one.

The dialect is crontab(5) as Vixie cron, cronie and Debian's cron implement it. `lib/cron.ts`
exists because of three of its rules, each of which a regular-expression reader gets wrong:

- **Day of month and day of week are joined with OR** when both are restricted. `0 0 13 * 5` runs
  on every 13th and every Friday. The page says so under any schedule that does it, with the
  `[ "$(date +\%u)" = 5 ] &&` workaround.
- **"Restricted" is read from the first character.** Cron's `DOM_STAR`/`DOW_STAR` flags are set
  when a field *begins* with `*`, so `*/2` in the day-of-month field counts as unrestricted and the
  OR becomes an AND; `1-31/2` means the same days and keeps the OR. `CronField.star` records the
  character separately from the values, and a note explains it where it bites.
- **Daylight saving depends on the kind of job.** cronie's main loop runs *fixed-time* jobs for
  every minute a forward jump skipped, at the jump, and does not repeat them when the clocks go
  back; jobs whose minute or hour begins with `*` follow the wall clock, losing the skipped hour
  and running twice in the repeated one. `nextRuns` models exactly that, labels each run a change
  touched (`gap`, `overlap-once`, `overlap-first`, `overlap-second`), and lists the wall times a
  wildcard job loses. systemd timers, busybox crond and cloud schedulers differ, and the page
  says so rather than pretending to speak for them.

Decisions that shape the rest:

- **"Never runs" is a proof, not a timeout.** Days are walked with `civilFromDays` and matched
  arithmetically; only a matching day asks `Intl` anything, and then only three times — a day
  before, midday, two days after — to tell a clock-change day from a steady one, so only the
  former converts each run on its own. The walk stops after 146,097 days, one Gregorian cycle,
  after which dates and weekdays repeat exactly — so nothing in it means nothing ever.
  `0 0 30 2 *` is proved in about 3 ms; `0 0 29 2 *` correctly skips 2100.
- **The sentence is built from the fields as written, not only from their values.** `*/15` reads
  as "every 15 minutes", `0 9-17` as "every hour from 09:00 to 17:00"; a few fixed minutes and
  hours become clock times. The field table beside it lists what each field expands to, so the
  sentence never has to carry every value.
- **Notes for the mistakes that do not fail loudly:** a step that does not divide its field
  (`*/7` leaves a four-minute gap at the top of the hour), a day some months lack (skipped, not
  moved — with the `28-31` plus `date -d tomorrow` idiom for the last day), an unescaped `%` in
  the command, the non-portable `5/15`, a sixth time field, `root` in a personal crontab, and what
  a shorthand stands for.
- **Other schedulers' syntax is refused by name** — Quartz and Spring (`?`, `L`, `W`, `#`, six or
  seven fields), Jenkins' `H`, Go's `@every`, an upper-case `@DAILY`, a four-letter day name — rather
  than misread as a crontab.
- **`CRON_TZ` applies to the lines below it**, as cronie reads it; an unknown zone is dropped and
  the setting's card says so.
- **The builder writes the portable form** — `5-59/15`, never `5/15` — and loading a line back
  never trades `0-59/5` for `*/5`, because that leading `*` is what the second and third rules
  read. When it cannot keep one (`*/2` in the day-of-week field becomes a list of days), it says so.
- Only the settings are stored (`tt-cron`: zone, language, names, user column). A crontab or a
  command can carry paths, addresses and tokens, so neither is ever written to storage.
- Checks in `verify-cron.ts`, described in §9.

### 6.21 Username generator — `/tools/username-generator/`

A random username made from a Marvel or DC superhero name, one on top and up to a hundred in the
bulk panel. It sits in the Security group beside the password and passphrase generators, because
those are the three things a sign-up form asks for.

| Control | Options | Default |
|---|---|---|
| Heroes from | Marvel (150), DC (128) — either or both | **both** |
| Letters | lowercase / Capitalised (first letter of every word) | lowercase |
| Words | Joined / With spaces | Joined |
| Digits at the end | none / 1 digit (0–9) / 2 digits (00–99) | none |
| Bulk count | 1 – 100 | 10 |

- **The list stores words, not strings.** `wordlists/heroes.ts` keeps every hero as its words in
  Title Case — Spider-Man as `Spider Man`, Ms. Marvel as `Ms Marvel` — so the two switches combine
  freely: `spiderman`, `SpiderMan`, `spider man`, `Spider Man`. The passphrase page's superhero
  list could not be reused: it stores `spiderman` as one word and mixes in heroes from other
  publishers. Heroes and the heroic side of the antiheroes, by codename; no villains and no
  civilian names.
- **Two digits are always two.** `07`, not `7`, so a list of names is one length and the space is
  exactly heroes × 100. In spaced mode the digits are a word of their own — `Spider Man 42` — so the
  spacing reads the same all the way along.
- **A bulk list never repeats.** The hero and the ending are drawn together as one index into
  heroes × endings, through `distinctIndices` (a Fisher-Yates stopped after *n* steps, kept sparse
  in a map), rather than drawn one by one and retried on a clash. Each universe holds at least
  `BULK_MAX` heroes, asserted in the suite, so even one universe with no digits fills a list of 100.
  Asking for more than the settings allow returns all of them once.
- **No strength meter.** A username is not a secret; `OutputPanel` takes `strength={false}`. What
  the page counts instead is the space — `278 heroes × 100 endings = 27,800 possible usernames` —
  because that is what decides how often a name comes back taken.
- **Spellings cannot collide.** The suite asserts every name is unique within and across the two
  lists once lowercased and joined, the coarsest of the four spellings, so two heroes never
  produce the same username.
- Only the four settings are stored (`tt-username`); generated names are not.

### 6.22 systemd OnCalendar explainer — `/tools/systemd-oncalendar/`

Bilingual (§5). Paste the value of a timer's `OnCalendar=` — one expression per line, or a whole
`.timer` file, whose `OnCalendar=` lines are read as systemd reads them, an empty one clearing
those above it. Each expression becomes a card:

- **Normalized form**, exactly as `systemd-analyze calendar` prints it, with a copy button — and,
  where systemd 259 would mishandle the expression, a **safer form** that means the same times.
- **A sentence** in English or Vietnamese, and a table of the fields as stored and as expanded.
- **Notes** for what surprises people: `weekly` is Monday; a weekday and a date must *both*
  match (the opposite of cron); a two-digit year; a range cut back to its last step; a day some
  months lack; `~` counting back from the month's end; sub-minute schedules and `AccuracySec=`;
  an old zone name such as `Asia/Saigon`.
- **Next runs** in the server's zone, with clock changes labelled: a skipped wall time does not
  run that day, a repeated one runs once, the first time.

With two or more lines, a merged list shows when the timer as a whole elapses, line by line.
*Coming from cron?* converts a five-field crontab schedule into one `OnCalendar=` line — or two,
when cron's day-of-month OR day-of-week has no single-line equivalent.

| Control | Options | Default |
|---|---|---|
| Server time zone | every zone the browser knows | the browser's own |
| Count from | now, or a wall time in the server's zone | now |

`lib/oncalendar.ts` is a port of systemd 259's `calendarspec.c`, rule for rule:

- **Parsing** in systemd's order — zone suffix, shorthand, weekdays, date (or `@epoch`), time —
  with its limits (years 1970–2199, 241 list items, seconds to six decimals). A refusal says why,
  and names the likely intent: a crontab line, `*/15`, an ISO `T`, a UTC offset (with the
  `Etc/GMT` spelling to use instead), a lower-case zone, a three-letter abbreviation.
- **Normalizing** as `normalize_chain` does — steps cut to their last value, repeats folded,
  lists sorted and de-duplicated — and printing as `format_chain` does, so the text matches
  `systemd-analyze` character for character.
- **Elapsing** by systemd's own search, wall clock first, including two things it gets wrong.
  A step with no end — `00/7` — runs past the end of its field, and systemd 259 normalises the
  overflow into the next unit and resumes in the wrong place: a run is lost at a month boundary,
  and near a clock change the search can give up with *Infinite loop in calendar calculation*,
  after which the timer stops. `nextElapses` reproduces both — which runs are lost, and where it
  gives up — and the list shows them struck through and explained. Steps that land exactly on the
  next unit (`*:0/15`, `0/6:00`) are unaffected; `boundedForm` rewrites the others (`00..21/7`).
- **Zones** through `Intl`, with systemd's case rules and a table of the aliases browsers resolve
  differently from tzdata (`Asia/Saigon`, `Europe/Kiev`, `US/*`).

The unit analyzer (§6.23) links here with the expression in the URL fragment, `#expr=…`, which
the browser never sends to a server. Only the zone is stored (`tt-oncalendar`).

### 6.23 systemd unit file analyzer — `/tools/systemd-unit-analyzer/`

Bilingual (§5). Paste a unit file — one, several pasted one after another, or the output of
`systemctl cat` with its `# /path` lines and drop-ins — or open one, or drop it on the box. An
optional file name sets the unit's type when nothing in the paste does. Four samples cover the
common shapes, including a service with the usual mistakes.

What comes back:

- **A verdict per unit**: systemd would refuse to load it; or it loads but ignores so many lines;
  or it reads every line.
- **Findings, in line order**, each tagged with its severity and with who says so — *systemd
  logs this* (a line systemd itself complains about), *systemd, about the unit* (a rule checked
  once all files are read), or *advice* (systemd says nothing; the page does). A finding names its
  line, which selects it in the box, and offers the line to write instead, with a copy button.
- **What the unit does**: type, command, user, restart policy, triggers and schedule for a
  timer, what enabling it does.
- **Every setting, line by line**, with a sentence on what it does (`unitdocs.ts`, English and
  Vietnamese, for about a hundred common ones) and a link to its entry in systemd's manual.

`lib/unitfile.ts` reads in three layers, each a port of systemd 259:

1. **The file format** (`conf-parser.c`): `#` and `;` comments, skipped even inside a continued
   line; a trailing backslash continuing a line (a backslash followed by spaces does not — advice);
   a continuation the file never finishes numbered one past the end, as systemd numbers it; the
   BOM; case-sensitive section and key names; `X-` sections and keys ignored silently; a broken
   section header stopping the file. `[Install]` is read by `systemctl enable`, not by the
   loader, so its findings are advice.
2. **Each value**, by the parser systemd uses for that key. The directive table,
   `unitdirectives.ts`, is generated from systemd's own `load-fragment-gperf.gperf.in` by
   `scripts/unit-directives.ts` — 535 names, each with a one-letter kind naming its parser — and
   regenerating it is how the analyzer follows a new systemd. The ports include
   `extract_first_word` with C escapes, `config_parse_exec` (prefixes `-@:|+!`, `;` separators,
   specifier expansion with the right table per setting), `parse_time`, `parse_size`,
   `parse_permyriad`, `safe_atou` with its 0x/0o/0b prefixes, signals, user names (relaxed and
   strict), unit names, paths, resource limits, environment assignments and documentation URLs.
   Lines systemd *refuses* — a relative `ExecStart=` path, an unknown `%` specifier in a command,
   an invalid `User=`, a relative `WorkingDirectory=` — are errors, and systemd stops reading the
   file there.
3. **The unit as a whole**: `service_verify()` in its order (no `ExecStart=`, two of them outside
   `Type=oneshot`, `Restart=always` on a oneshot, `Type=dbus` without `BusName=`…) and its
   warnings, `timer_verify()`, and a second `Unit=` in a timer.

**Drop-ins behave as systemd makes them behave**: lists add up, so a drop-in's `ExecStart=`
without an empty line before it gives the service two (the fix offered is both lines); a fatal
line in a drop-in stops only that drop-in and the unit still loads; a fatal line in the unit
file itself means its drop-ins are never read, which the page says on each of them.

**Advice** covers what systemd accepts in silence: `date +%Y-%m-%d` in a command, where `%Y`,
`%m`, `%d` are systemd's own specifiers; shell syntax (`>`, `|`, `&&`, `$(…)`, a trailing `&`)
with no shell to read it; `sudo`; a misspelt capability, which systemd drops without a word;
`Restart=` with the default 100 ms pause; `network-online.target` wanted but not ordered after; a
timer without `[Install]`, or only relative triggers; a service a timer starts that is also
enabled at boot; an `OnCalendar=` step systemd 259 mishandles (§6.22).

Nothing is stored: a unit file can name hosts, paths and credentials.

### 6.24 Byte & throughput converter — `/tools/byte-converter/`

Bilingual (§5). The question it exists for is in its description: 5 TB over 1 Gbps takes
40,000 seconds — 11 h 6 min 40 s, about 11.1 hours.

- **Ask in one line.** A size and a speed give the time (`5 TB @ 1 Gbps`); a size and a time, the
  speed needed (`1 TB in 2 h`); a speed and a time, what it moves (`300 Mbps for 1 day`); a size
  or a speed followed by a unit converts (`1 TB to GiB`). Joining words in English or Vietnamese
  (`qua`, `trong`, `sang`), times as systemd writes them or in Vietnamese words (`2 giờ 30 phút`).
- **Sizes** — one value in every decimal, binary and bit unit, side by side.
- **Speeds** — every bit and byte rate, and what the speed moves per minute, hour, day and 30 days.
- **How long will it take?** — the same sum with numbers and unit menus, for a phone.
- **Reference tables**, computed at build time by the same code: disk sizes against what Windows
  shows (why a 1 TB drive is 931 GB), and common link speeds with the time to move 1 GB and 1 TB.

Four links under the title jump to the four tools — `#ask`, `#sizes`, `#speeds`, `#time` — the
same plain anchors as the crontab page (§6.20), in both languages. `.jump--grid` lays them out as
one even row on a wide screen and two by two below 660px, so on a phone they take two rows
instead of four full-width ones.

| Control | Options | Default |
|---|---|---|
| Of the link's speed, data gets | line rate · TCP over Ethernet, MTU 1500 (1448 of 1538 bytes, 94.1%) · 90% · 80% | line rate |

`lib/bytes.ts` decisions:

- **Exact fractions.** Every quantity is a ratio of two BigInts counted in bits, bits per second
  or seconds. Rounding happens once, when a number is printed, with `≈` in front when it was.
- **Units by the standards** — k, M, G… powers of 1000; Ki, Mi, Gi… powers of 1024; b a bit, B a
  byte — **read forgivingly**: `500gb` is gigabytes and `mbps` megabits per second, as people mean
  them, and the page says when it read a unit that way. `KB` is read as 1000 bytes, with a note
  that Windows and RAM often mean 1024.
- **Numbers in the page's language.** `1.5` and `1,5` are both one and a half; a single separator
  followed by exactly three digits is a thousands separator in the page's language — `1,000` in
  English, `1.000` in Vietnamese — and output is grouped the same way.
- Only the overhead choice is stored (`tt-bytes`).

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

### 8.6 Certificates: what is hand-written, and why

Every key is generated and every signature made by WebCrypto. What this project writes is the
*structure* around them — ASN.1 DER, X.509, PKCS#10, PKCS#12, JKS — because there is no browser
API for any of it and the alternative was a dependency an order of magnitude larger than the site.

That structure is where the sharp edges are, and four of them are worth recording:

1. **ECDSA signatures come out of WebCrypto in the wrong shape.** `crypto.subtle.sign` returns the
   raw `r || s` of IEEE P1363; X.509 wants `SEQUENCE { INTEGER r, INTEGER s }`. Omitting the
   conversion yields a certificate that parses cleanly and verifies nowhere.
2. **RSA signature algorithms carry an explicit NULL parameter; ECDSA ones must carry none.** Both
   are in RFC 4055, and both are easy to get backwards.
3. **An ECDSA certificate is never given `keyEncipherment`.** An EC key cannot encipher a key, so
   the bit is a claim the key cannot honour. It is dropped whatever the user ticks, and the page
   says it was.
4. **A root CA gets no extended key usage.** An EKU on a CA constrains everything issued beneath
   it, which is a decision for someone deliberately building a constrained sub-CA, not a default.

**Two key derivations live in one .p12.** The private key is encrypted with PBES2 —
PBKDF2-HMAC-SHA256 at 200,000 rounds into AES-256-CBC — all of which WebCrypto does natively. The
integrity MAC cannot use PBKDF2: RFC 7292 specifies its own KDF (appendix B.2), so that one is
written out by hand at the customary 2,048 rounds. PBMAC1 (RFC 9579) would be PBKDF2 and much
nicer, but it is from 2024 and nothing old enough to still want a .p12 can read it. Certificates go
in unencrypted — they are public by construction, and leaving them readable means `openssl pkcs12
-info -nokeys` can list the file without the password.

**JKS is included under protest.** Its key protection is a SHA-1 keystream XOR with no iteration
count and no MAC over the key itself, which is indefensible by any modern reading and cannot be
fixed from here: it is the format. It exists for the JDK 8 Tomcat and the appliance whose config
says `storetype JKS`. The page offers .p12 first and says which to prefer. The format is defined
only by the source of `sun.security.provider.JavaKeyStore`, and one detail that source does not
make obvious cost a bug: the key protector's `AlgorithmIdentifier` must carry an explicit NULL
parameter. ASN.1 makes it optional and Java itself reads only the OID, so omitting it produces a
keystore Java opens happily — and that other readers refuse outright. A check now pins it (§9).

**Reading an encrypted key has a hard floor.** PBES2 — PBKDF2 into AES-CBC — is what OpenSSL 1.1
and later write, and WebCrypto does both halves, so those keys open. OpenSSL's traditional
`DEK-Info` PEM opens too: its key schedule is `EVP_BytesToKey`, one round of MD5, which `md5.ts`
already provides. What cannot be opened at all is anything using DES, 3DES or RC2 — `PBE-SHA1-3DES`
most of all, since that was the default for years. WebCrypto implements none of those ciphers and
never will, so the page names the scheme and gives the `openssl pkcs8` line that converts it,
rather than reporting a wrong passphrase. The two failures need different things from the user and
so must not share a message.

**RFC 1421 headers are parsed, not stripped.** A traditional encrypted PEM carries `Proc-Type` and
`DEK-Info` above its body. Filtering the body down to base64 characters, which is the obvious way
to be forgiving about pasted text, keeps the letters in `ProcType` and `ENCRYPTED` and corrupts the
key silently. The headers are split off on a blank line instead, and only when a blank line
actually closes them — otherwise base64 containing a colon would be mistaken for a header.

**The OpenSSL script is a claim, so it is executed.** Showing commands that look right and do
something else would be worse than showing none, so the verification writes the displayed script to
a file, runs it with `sh`, and diffs the resulting certificate against the page's. Three things
that reads as correct turned out not to be, and only running it found them:

- **`-utf8` is not optional.** Without it OpenSSL reads `-subj` as Latin-1, so `O=Công ty ABC`
  becomes `O=CÃ´ng ty ABC` — a valid certificate with the wrong name in it, from a command that
  reported success. For this tool's audience that is the common case, not an edge one.
- **`-subj` values need escaping** for `/`, `+` and `=`, which OpenSSL reads as structure. `O=A/B
  Ltd` silently becomes two attributes otherwise.
- **Git Bash rewrites a leading `/`.** `-subj '/CN=x'` arrives as `C:/Program Files/Git/CN=x`,
  and the error names neither the shell nor the cause. The script stays correct POSIX and the page
  carries the `MSYS_NO_PATHCONV=1` note instead of contorting itself for one shell.

**What the script deliberately does not carry** is a passphrase. `-passin`/`-passout` on a command
line puts a key's passphrase in the shell history and in `ps`, so the commands let OpenSSL prompt,
and a check asserts no `-pass` flag ever appears in the output. Extensions go in the CSR only when
the CSR is bound for someone else's CA; when the page's own script signs it, `x509 -req` takes them
from `-extfile` and ignores the CSR's, so repeating them would only raise the question of which
copy wins.

**Nothing is persisted.** A CA made on the page lives in a module variable for the life of the tab.
Storing private keys in `localStorage` was considered and deferred rather than built: it is a real
convenience with a real cost, and it deserves its own decision (§12) rather than arriving as a
side effect of this tool.

---

## 9. Verification

```bash
npm run verify   # 1,637 checks, Node, no browser — about two minutes with systemd reachable
npm run check    # astro check — TypeScript across .astro and .ts
npm run build    # runs check first, then the static build
```

`scripts/verify.ts` imports the same `lib/` modules the browser runs and asserts:

- **RNG uniformity** — 600,000 draws of `randomInt(6)` stay within 2% of expectation;
  120,000 shuffles place a given element uniformly.
  `distinctIndices` puts its first and second draws uniformly over 120,000 runs, never repeats, and
  drawing every index is a permutation.
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
- **Unicode escapes** — a JSON-escaped Vietnamese string decoded to the sentence it stands for,
  surrogate pairs joining into one emoji, `\0` and `\a` behaving as documented, quote trimming only
  on a real pair, strict mode refusing four malformed sequences and reporting the offset into the
  original input, both encoder styles, and a round-trip whose escaped form `JSON.parse` agrees
  with.
- **JSON** — pretty/minify/sort/tab output, seven pinned error offsets (§8.4), that array order
  survives sorting, and that JSON5-isms (trailing commas, unquoted keys, comments) are rejected.
  For *Open file*: the same accented document as UTF-8, UTF-8 with a BOM, and UTF-16 LE and BE
  with a BOM all decode to identical text that formats, and a one-byte file is not taken for
  UTF-16.
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
- **DER** — length encoding at 0/127/128/255/65535/65536, INTEGER sign padding and zero
  stripping, OID encoding both ways, `KeyUsage` named bits with the right unused-bit count, and
  the UTCTime/GeneralizedTime switch at 2050.
- **Certificates** — every generated certificate is parsed by **Node's `X509Certificate`**, which
  reports the subject, issuer, SANs, validity and CA flag, and **verifies the signature**. A leaf
  is checked against its CA with `verify()` and `checkIssued()`, for an RSA CA signing an EC leaf
  and for an ECDSA P-384 CA, which is what catches a raw-versus-DER ECDSA signature.
- **OpenSSL**, when on PATH, parses the certificate and the CSR, checks the CSR's self-signature
  with `req -verify`, confirms the AKI matches the issuing CA's SKI, and opens the .p12 —
  deriving the PBES2 key from the password, decrypting the private key, and proving the key
  inside matches the certificate beside it. A wrong password is asserted to fail.
- **Refusals and warnings** — that a missing CN, a three-letter country, zero days and a key
  belonging to a different CA are all refused with a message; and that a TLS certificate with no
  SANs, no purpose at all, an issuer that is not a CA, and a leaf outliving its CA each produce a
  warning without blocking generation.
- **Intermediate CAs** — a root signs an intermediate, the intermediate signs a leaf, and
  **OpenSSL validates the whole three-tier path** with `verify -untrusted`. The intermediate is
  checked for `CA:TRUE`, its `pathlen`, the absence of an EKU, and that it is signed by the root
  rather than by itself — which is exactly what broke when being a CA stopped implying being
  self-signed, and what the check now pins.
- **Encrypted keys** — keys written by **OpenSSL itself** in four forms (PBES2 with AES-256 and
  SHA-256, with AES-128 and the SHA-1 PRF, at OpenSSL's own default, and the traditional
  `DEK-Info` PEM) are opened and compared byte for byte against the PKCS#8 that went in; an EC key
  takes the same path; a `PBE-SHA1-3DES` key is asserted to be refused *by name* with the
  conversion command; a missing and a wrong passphrase are each refused with their own message;
  and a certificate is signed end to end with an encrypted CA key.
- **PEM headers** — that a `Proc-Type`/`DEK-Info` block's body survives intact, that the headers
  are read, and that ordinary base64 is never mistaken for a header.
- **The OpenSSL script is run, not inspected.** For five shapes of form — two roots, a TLS leaf,
  an intermediate and a document-signing certificate — the script the page displays is written to
  a file, executed with `sh`, and the certificate that falls out is compared field by field
  against the one the page builds from the same form. `openssl verify` then validates what the
  script signed. A sixth case puts `/`, `+` and an apostrophe in the subject and asserts the name
  survives the shell, `-subj` and the certificate intact. This is the only way the claim
  "these commands do what the button does" can be made honestly.
- **JKS** — magic, version, entry layout, the lower-cased alias, the trailing
  `SHA-1(password || "Mighty Aphrodite" || body)` digest recomputed independently, the key
  protector undone back to the original PKCS#8, and the explicit NULL parameter that §8.6
  describes.

**Structural passphrase assertions draw from BIP39, deliberately.** They split a phrase on its
separator to count words, and a tarot name carries its own `_` that breaks that assumption. BIP39
contains no punctuation at all, so the assertion tests the generator rather than the list.
Separate checks split tarot phrases under hyphen, underscore and dot separators and confirm every
part is a whole card, which pins the joiner swap.
- **Registry accuracy** — the `size` advertised beside each wordlist matches the list actually
  loaded, so the bits-per-word note can never describe the wrong list.
- **Entropy arithmetic** — exact bit values for known password configurations, tier boundaries,
  and crack-time formatting at both extremes. The pool sizes the passphrase hint reports — 2,140
  for the default, 2,218 with every list — are pinned in the merging checks.
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
- **Transaction codes** — the worked example pinned field by field, the leap-day cases (day 60 is
  1 March in a common year and 29 February in a leap one, day 366 exists only in a leap year),
  the century being applied rather than assumed, every refusal by name and by type, a generated
  sample decoding back to its own date at every legal length, and **all 36,525 days of
  2000–2099 out through the prefix and back**, which is what pins the two directions to each
  other rather than to a handful of fixtures.
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
- **Cron** — 232 checks in `verify-cron.ts`. Every operator's expansion is pinned, with the
  leading-`*` flag asserted apart from the values; 29 refusals by name; 28 descriptions in both
  languages. The run search is held to an **independent oracle** — its own field expander and a
  minute-by-minute matcher written again from crontab(5), sharing no code with `cron.ts` — over
  400 seeded random expressions and the next 800 days. Daylight saving is pinned at New York's
  2026 transitions and Lord Howe's thirty-minute one, then checked as whole-year properties in
  three zones: a fixed-time job runs exactly once on each of 365 local days, and `30 * * * *`
  runs once for every :30 the wall clock shows — none in a gap, two in a repeat. The builder
  writes 2,000 random settings, each parsed back to exactly the values chosen and read back into
  the same string.
- **Usernames** — the hero list's rules (one to three `[A-Z][a-z]+` words, no name twice once
  lowercased and joined, at least 100 per universe), the four spellings and where the digits go in
  each, the shape of 300 draws under six settings, each universe drawing only its own heroes, bulk
  lists that never repeat, all hundred two-digit endings reached with the leading zero kept, and
  one-digit endings uniform over 100,000 draws.
- **systemd OnCalendar** — 405 checks in `verify-systemd.ts`. Pinned answers recorded from
  systemd 259: 140 normalized forms, 43 refusals with their reasons, 66 descriptions in both
  languages, notes, and 75 elapses around real clock changes in New York, Lord Howe, London and
  Santiago, including where systemd 259 skips a run or gives up. An **independent matcher** —
  the normalized text expanded into sets and matched minute by minute, sharing no code with the
  library — checks 500 random expressions, and 300 crontab schedules converted to `OnCalendar=`
  must elapse exactly when `cron.ts` says cron runs them. Then **systemd itself**: where
  `systemd-analyze` can be run (Linux, or WSL on Windows), 1,136 generated expressions — random
  ones, steps that overflow near a clock change in seven zones, steps across midnight, month and
  year ends — go to `systemd-analyze calendar` and to the library, and the validity, the
  normalized text and every elapse must agree, including every case where systemd cannot schedule
  at all. Without systemd these are skipped, as the OpenSSL checks are.
- **systemd unit files** — `verify-units.ts`. 47 pinned cases assert every finding of a unit
  file with the usual mistakes, line by line, with the line it offers instead; every finding and
  fact has an English and a different Vietnamese sentence. Then **`systemd-analyze verify`**:
  every directive systemd 259 knows, each with a pool of good and bad values for its kind —
  4,283 one-line files — plus 250 generated whole files with mistakes mixed in (wrong case, stray
  lines, continuations, comments, broken headers) and 120 units with drop-ins pasted as
  `systemctl cat` prints them. For each, systemd and the analyzer must agree on which lines systemd
  complains about, whether at warning level or quieter, what it says about the unit, and whether it
  loads at all. Verify runs with `--recursive-errors=no` where it can, which is nine times faster but
  silences the warnings about dependencies, so files with `After=`, `Wants=` and the like run in
  full.
- **Time spans** — 24 pinned readings of `parse_time` (`5Min` is months and then fails, `10 20` is
  thirty seconds, `12.34.56` is refused), and 400 generated spans read by `systemd-analyze
  timespan`, compared exactly — in BigInt, since a span past 285 years no longer fits a double —
  and printed identically, dot notation included.
- **Bytes** — 82 checks in `verify-bytes.ts`: the units exactly (1 TiB is 1,099.511627776 GB),
  the sum the page exists for (5 TB at 1 Gbps is exactly 40,000 seconds, said in both languages,
  and 11 h 48 min 6 s over TCP and Ethernet), numbers as people type them in each language, units
  as people write them and which ones carry a note, and 18 one-line questions with what each is
  read as.

**What the systemd oracle found.** Holding the libraries to systemd rather than to its manual
turned up behaviour the manual does not describe, and the pages now say what systemd actually
does: the overflow in uneven steps and the *Infinite loop* it ends in at a clock change (§6.22);
that a fatal line in a drop-in does not stop the unit loading, while one in the unit file stops its
drop-ins from being read; that a percent sign before a letter systemd does not know is fatal in a
command line but only a warning elsewhere; that `CPUSchedulingPolicy=` and `IOSchedulingClass=`
take numbers as well as names; that conditions take `|` and `!` with no space after them; and that
an unknown capability name is dropped without a word above debug level.

Run it after touching anything in `src/lib/`.

**Browser runs.** Since the JSON highlighting work, each UI change has also been driven in
headless Chrome over the DevTools protocol — type into the page, read the DOM, take screenshots,
collect uncaught exceptions. The scripts are throwaway and not in the repository; §11 gap 2 is
about making that permanent.

The certificate tool was driven that way end to end: all three modes, a CA promoted to sign a
leaf, both keystores downloaded through Chrome's own download path, and the downloaded files then
opened by **OpenSSL** (.p12) and **pyjks** (.jks) outside the browser. `openssl verify` accepts the
chain the page produced. That run caught three things a build cannot: `[hidden]` being defeated by
`.field { display: flex }`, the saved signature hash being overwritten on load, and a leaf
inheriting its CA's ten-year validity when promoted. The later round that added intermediates,
encrypted keys and DER loading was driven the same way, and caught a fourth: promoting a CA left
the *this is itself a CA* box ticked, so the next certificate would quietly have been a second
intermediate. The round that added the OpenSSL panel went one step further — the script was read
out of the rendered DOM and run outside the browser, which is the only way to know that what a
visitor can copy is what was tested.

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
| Text-tool wiring, shared format helpers included | 4.0 KB (1.7 KB) | the text tools |
| Password page script | 3.2 KB (1.5 KB) | password page |
| Passphrase page script | 3.0 KB (1.4 KB) | passphrase page |
| Base64 page script | 1.7 KB (1.0 KB) | Base64 page |
| Hash page script | 3.3 KB (1.6 KB) | hash page |
| JSON page script | 3.7 KB (1.9 KB) | JSON page, highlighting included |
| YAML page script | 2.6 KB (1.3 KB) | YAML page |
| Epoch page script | 11.6 KB (4.8 KB) | epoch page |
| Lunar page script | 7.7 KB (3.6 KB) | lunar calendar page |
| Transaction code page script | 7.7 KB (3.4 KB) | transaction code page |
| Crontab page script, `cron.ts` included | 33.7 KB (13.1 KB) | crontab page |
| OnCalendar library, `oncalendar.ts` | 47.0 KB (17.2 KB) | OnCalendar and unit analyzer pages |
| OnCalendar page script | 16.7 KB (6.9 KB) | OnCalendar page |
| Unit analyzer page script, `unitfile.ts`, the directive table and `unitdocs.ts` included | 129.7 KB (43.2 KB) | unit analyzer page |
| Time span library | 2.4 KB (1.0 KB) | unit analyzer and byte converter pages |
| Byte converter page script, `bytes.ts` included | 18.9 KB (7.0 KB) | byte converter page |
| Language switch, `lang.ts` + its page hook | 0.9 KB (0.6 KB) | bilingual pages |
| IPv6 library | 5.3 KB (2.4 KB) | IPv6 page and the three range tools |
| Range library | 4.9 KB (2.1 KB) | range, aggregator and splitter pages |
| Range / aggregator / splitter / IPv6 page scripts | 1.1 / 3.0 / 3.4 / 2.7 KB | their pages |
| Username page script, hero list included | 6.1 KB (2.9 KB) | username page |
| Superhero wordlist | 0.8 KB (0.5 KB) | passphrase page, on demand |
| Tarot wordlist | 1.1 KB (0.4 KB) | passphrase page, on demand |
| BIP39 wordlist | 12.8 KB (6.2 KB) | passphrase page, on demand |
| js-yaml | 58.2 KB (17.4 KB) | YAML page, on demand |

A tool page is about 6 KB of gzipped JavaScript before the wordlist. The unit analyzer is the
outlier, at about 66 KB with the OnCalendar library it reads timers with: most of it is the two
sentences, English and Vietnamese, behind each of its findings, and the parsers ported from
systemd. That is a deliberate trade for saying exactly what systemd does in both languages; gap 21
records how to halve it.

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
8. **Localisation is four pages deep.** The lunar calendar is Vietnamese, and the two systemd
   tools and the byte converter are written in both languages with a switch (§5, *Bilingual
   pages*). Every other page is English, so a Vietnamese reader who follows a link from one of
   those lands in English. The crontab page only describes schedules in Vietnamese.
9. **Tarot cards next to a random-symbol separator.** The card joiner steers clear of a fixed
   `_` or `-` separator, but the random-symbol alphabet holds both, so a phrase like
   `the_fool_ace_of_cups` can occur and cannot be split back into cards unambiguously. Entropy
   is barely touched, and the fix would be a per-gap redraw that skews the separator
   distribution; it is recorded rather than worked around.
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
14. **The JKS checks in the repository have no independent oracle.** `npm run verify` undoes the
    format with the same understanding that wrote it, so it catches a regression but would not
    catch a misreading of Sun's source. The files *were* validated during development by
    **pyjks**, which is what found the missing NULL parameter described in §8.6 — but pyjks needs
    a C compiler to install and keytool needs a JDK, so neither is a dependency the verification
    can assume. The PKCS#12 has no such gap: OpenSSL checks it on every run where OpenSSL exists.
15. **A CA still cannot arrive as a `.p12`.** The page writes PKCS#12 but does not read it, and a
    CA that already exists is as often in a `.p12` as in a pair of PEMs. Most of the parts are
    there — the DER reader, PBES2, the RFC 7292 KDF — so what is missing is the container walk,
    plus the same cipher floor as everywhere else: a legacy `.p12` encrypted with 3DES or RC2 will
    not open in a browser whatever is written.
16. **No CRL, and no revocation of any kind.** Nothing issued here can be withdrawn, and the
    certificates carry no CRL distribution point or OCSP responder, so nothing checking for
    revocation will find anything to check. For a PKI whose certificates are short-lived that is
    survivable; for one that is not, it is the reason to use a real CA instead.
17. **No certificate *decoder*.** The ASN.1 reader in `asn1.ts` and `parseCertificate` in
    `x509.ts` already do most of the work the decoder idea in §12 called for, but there is no page
    that takes a PEM and explains it.
18. **The crontab explainer speaks one dialect, and its DST model has no live witness.** It reads
    Vixie cron, cronie and Debian's cron; systemd `OnCalendar` has its own page now (§6.22), but
    Kubernetes' `timeZone` field and AWS's six-field expressions are not read, and Quartz is
    refused rather than converted. The
    daylight-saving behaviour follows cronie's main loop as described in §6.20 and is checked
    against the zone database and an independent matcher — not against a running cron daemon,
    which the machine this was built on does not have. Vietnamese covers the sentence and the
    field meanings only; the run list's relative times ("in 3 days") stay English.
19. **The unit analyzer reads the file, not the machine.** It cannot know whether the programs,
    users, paths and other units a unit names exist, which `systemd-analyze verify` on the server
    does check. About a hundred directives whose values have a grammar of their own —
    `SystemCallFilter=`, `RestrictAddressFamilies=`, `DeviceAllow=`, `IPAddressAllow=`,
    `LoadCredential=` and the like — are recognised but their values are not checked. Socket,
    mount, path and swap units get the generic checks and the shared exec settings, not the
    unit-wide rules a `.service` and a `.timer` do.
20. **Both systemd tools are pinned to systemd 259.** The directive table regenerates from a new
    systemd's source in one command, but the ported parsers, the pinned answers and systemd 259's
    step overflow do not follow on their own: a later release that fixes the overflow, renames a
    setting or loosens a parser needs the oracle run against it, which the suite does whenever the
    WSL distribution's systemd is upgraded — and then fails, rather than drifts.
21. **The unit analyzer's page is heavy** (§10): every message ships in both languages. Splitting
    the messages into one module per language and loading the other only when the switch is
    used would roughly halve it; the OnCalendar library could also load only when a timer is
    pasted.

---

## 12. Roadmap and ideas

A running record of what was decided, what is done, and what is next. Newest decisions first.

### Decisions on the systemd tools and the byte converter

Made while building §6.22–§6.24:

| Question | Decision |
|---|---|
| Page language | **Both, with a switch** (§5) — the tools were asked for in English and Vietnamese, and a page per language would split one tool in two |
| A new group? | **System**, with the crontab generator moved into it — the three tools for scheduling and running services |
| Which systemd? | **259**, the release the WSL distribution ships, ported from its source and held to its own `systemd-analyze` |
| Explain what systemd says, or what it means? | **What it does**, including its mistakes — a timer that skips runs is described as skipping them, with the fix beside it |
| Directive list by hand, or generated? | **Generated** from systemd's gperf table, so the analyzer knows exactly what systemd knows |
| Keep reading after a line that stops systemd? | **No** — systemd does not, and a list of problems systemd would never have reached would mislead |
| Advice that systemd does not give? | **Yes, labelled as advice** — `date +%F`, shell syntax and a timer that cannot be enabled are the mistakes people make most |
| Store the pasted unit file? | **Never** — it can name hosts, paths and credentials |
| Byte arithmetic in floats? | **No: exact fractions** — 5 TB at 1 Gbps must be 40,000 seconds, not 39,999.99… |
| `gb` and `mbps`: by the standard, or as meant? | **As meant**, with a note saying how it was read |
| Thousands separators | **The page's language decides** a lone `1,000` or `1.000` |

### Decisions on the username generator

Made while building §6.21:

| Question | Decision |
|---|---|
| Reuse the passphrase page's superhero list? | **No** — it stores `spiderman` as one word, so it cannot be spaced, and mixes in other publishers |
| Which group? | **Security**, beside the password and passphrase generators — the three a sign-up form asks for |
| Capitalised joined: `Spiderman` or `SpiderMan`? | **`SpiderMan`** — the spaced form with the spaces taken out, and readable |
| Two digits: `7` or `07`? | **`07`** — one length for every name, and exactly heroes × 100 |
| Digits in spaced mode | **A word of their own**: `Spider Man 42` |
| Default | **lowercase, joined, no digits** — the plain name first; digits are for when it is taken |
| Strength meter? | **No** — a username is not a secret; the page counts the possible usernames instead |

### Decisions on the crontab tool

Made while building §6.20:

| Question | Decision |
|---|---|
| One page or two (generator, explainer)? | **One page** — a built line and a pasted one need the same explanation, and *Edit in builder* joins them |
| Page language | **English**, with the description switchable to **Vietnamese** — a tool option, not a page language |
| Which dialect? | **crontab(5) as Vixie cron, cronie and Debian ship it**; Quartz, Jenkins and Go syntax refused by name |
| Next runs around a clock change | **cronie's rules** — fixed-time jobs once, wildcard jobs by the wall clock — each affected run labelled |
| How far to search before "never"? | **One Gregorian cycle, 146,097 days** — after it the calendar repeats, so the answer is exact |
| A weekday step in the builder? | **No** — seven chips are quicker, and `*/2` restarts on Sunday in a way nobody means |
| Remember the crontab between visits? | **No** — only settings; a crontab can carry paths, addresses and tokens |

### Decisions on the network group

Asked and answered before building §6.8–§6.11:

| Question | Decision |
|---|---|
| One page with modes, or separate tools? | Separate pages in a **Network** group, with a sibling strip |
| Header: dropdown menus per group, or links? | **Four links** to the grouped sections of the home page |
| UI language for the new tools | **English**, like every page but the lunar calendar |
| VLSM (allocate by host counts) in the splitter? | **No** — equal splits only |
| IPv6 in the range, aggregator and splitter tools now or later? | **Now** — one `bigint` implementation serves both families |

### Decisions on the certificate tool

Asked and answered before building §6.14:

| Question | Decision |
|---|---|
| One page with modes, or separate pages per mode? | **One page, three modes** — all three share the CA and the subject form |
| What should the "Java" export be? | **Both** — a .p12 for a modern JVM and a real .jks for the stacks that insist |
| Where do saved CAs live? | **Nowhere, for now** — memory only for the tab. Persistence is its own decision |
| A library (PKI.js, node-forge) or hand-written? | **Hand-written** — 12.8 KB gzipped against an order of magnitude more, and §1 |
| Ed25519 keys? | **No** — WebCrypto support is too recent to rely on, and few stacks accept the certificates |
| Legacy PKCS#12 encryption (3DES)? | **No** — WebCrypto has no 3DES, so PBES2/AES only |
| Where does "is a CA" live? | **On the certificate, not the mode** — otherwise an intermediate is unreachable |
| A fourth mode for intermediates? | **No** — a tick box in the signed mode, since everything else about the form is identical |
| Decrypt CA keys in the page? | **Yes**, for PBES2 and the traditional `DEK-Info` PEM. Refuse DES/3DES/RC2 by name |
| Accept binary DER? | **Yes**, through a file picker — a textarea cannot take binary, and `.crt` files are everywhere |
| Show the equivalent OpenSSL commands? | **Yes, live** — and run them in the verification, since an unrunnable command is worse than none |
| Which shell for the script? | **POSIX `sh` only** — the extensions need a heredoc, which PowerShell has no equivalent of |
| Put the passphrase in the shown commands? | **Never** — `-passin` leaks into shell history and `ps`; let OpenSSL prompt |

### Done

| Area | What |
|---|---|
| Generators | Password and passphrase generators, entropy readout, bulk mode; username generator from Marvel and DC hero names |
| Data formats | Base64, hash (MD5/SHA-256/SHA-512), JSON with syntax highlighting, YAML, Unicode text spoofer with code-point changes, Unicode escape converter |
| Network | Subnet calculator with cheat sheet and canonical CIDR, IP range to CIDR, CIDR aggregator/supernet, CIDR splitter, IPv6 calculator; byte and throughput converter — SI and IEC units, bit rates, transfer time in one line |
| Date & time | Epoch converter with two-way quick convert and DST-aware wall time; Vietnamese lunar calendar |
| System | Crontab generator and explainer with next runs across clock changes; systemd OnCalendar explainer held to `systemd-analyze calendar`; systemd unit file analyzer held to `systemd-analyze verify` |
| Certificates | Root CA, CA-signed certificates and CSRs; purpose-driven key usage and EKU; PEM, PKCS#12 and JKS export |
| Site | Tool groups on the home page, group links in the header, sibling strip, Vietnamese chrome for the lunar page, bilingual pages with a language switch |

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
6. **Certificate decoder** (gap 17): PEM in, subject, SANs, validity, key and fingerprints out.
   Most of the cost was the ASN.1 reader, which §6.14 already paid.
7. **Read a `.p12`** (gap 15), so a CA that lives in one can be used without a detour through
   `openssl pkcs12 -nodes`.
8. **Saved CAs** (§6.14): the deferred half of the certificate tool. The question it has to answer
   first is not technical — an unencrypted private key in `localStorage` is a real cost on a site
   whose whole claim is that nothing leaves the browser, and a passphrase-wrapped one trades that
   for a passphrase the user can lose. Not built until that is decided rather than defaulted.

### Ideas not yet scheduled

Collected while planning; all fit the static, nothing-leaves-the-browser constraint in §1.

- ~~**Cron expression explainer**~~ — built as §6.20, with a builder beside it; systemd
  `OnCalendar` got its own page, §6.22.
- **chmod / umask calculator** — octal ↔ `rwx` ↔ symbolic, with setuid/setgid/sticky.
- **Regex tester** — JavaScript dialect, stated as such; matches, named groups, replacement preview.
- ~~**Certificate / CSR decoder**~~ — promoted to the list above now that §6.14 has written the
  ASN.1 reader that was "the real work".
- **MAC address tool** — format normalisation, EUI-64, U/L and multicast bits, and an OUI vendor
  lookup (the one idea with a sizeable dataset, ~300 KB lazy-loaded).
- **URL parser and encoder**, **HMAC** (a small extension of the hash tool), **TOTP code
  generator**, **config format converter** (JSON ↔ YAML ↔ TOML ↔ `.env`).
- ~~**Data size and transfer-time calculator**~~ — built as §6.24.
- **IPv6 in the subnet calculator** — see gap 10.

Deliberately out of scope: anything that needs a server or a third-party API — ping, traceroute,
DNS lookups, whois, port scans, checking a live site's certificate. Each would break the promise in
§1, and the privacy page says so in as many words.
