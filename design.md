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
- No analytics, no tag manager, no error-reporting SDK, no third-party fonts or assets. The page
  makes no network request after its own assets have loaded — a claim that is checked at build
  time (see §9).
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
| Styling | Hand-written CSS, custom properties | ~1000 lines total. A utility framework would ship more bytes than the entire site. |
| Client JS | Vanilla ES modules | Two forms and a meter. A UI framework would be the single largest asset on the page. |
| Hosting | Vercel, static output | No adapter, no serverless function, no runtime. |
| Verification | `scripts/verify.ts` in Node | See §9. |

One runtime dependency (`astro`), and it does not ship to the browser. Dev dependencies are
`typescript`, `@astrojs/check`, `@types/node`, `esbuild`.

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
│   ├── clipboard.ts       Copy, with a non-secure-context fallback
│   ├── ui.ts              THE ONE EXCEPTION: DOM helpers. See §4.
│   └── wordlists/         BIP39, superhero and EFF lists as string modules
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
│   └── BulkPanel.astro    Count, generate, copy-all, download, per-row copy
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
│       └── passphrase-generator.astro
│
└── styles/global.css      Design tokens, light + dark, all component styles
```

Rough scale: 800 lines of logic in `lib/`, 508 of components and layouts, 850 of pages, 1014 of
CSS, 338 of verification. The wordlist modules are generated and excluded from that count.

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

**The one exception is `lib/ui.ts`**, which is DOM-only by nature: `el`, `attachCopy`,
`renderStrength`, `attachBulk`, `loadPrefs`. It lives in `lib/` because both tool pages import it,
not because it fits the rule. It is deliberately the only file there that does, and
`scripts/verify.ts` does not import it.

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
| Wordlists | BIP39 English (2,048), Superheroes (101), EFF Large (7,776), EFF Short (1,296) — **any combination** | **BIP39 + Superheroes** |
| Separator | hyphen, dot, underscore, space, none, random digit, random symbol, **custom** | hyphen |
| Custom separator | any text, capped at 8 characters | `-` |
| Capitalisation | lowercase, Title Case, UPPERCASE, one random word uppercase | lowercase |
| Append a digit | on / off | **on** |
| Append a symbol | on / off | off |
| Bulk count | 1 – 50 | 10 |

- **Lists combine.** Ticking several draws from the union of all of them. Merged pools are cached
  by the exact set that produced them, so toggling a list on and off costs one merge.
- **Merging deduplicates, and that is correctness rather than tidiness.** The lists overlap
  heavily — 870 words are in both BIP39 and the EFF large list; all four together hold 9,142
  distinct words out of 11,221 raw entries. A plain concatenation would do two wrong things at
  once: report `log2(11,221)` bits for a pool that does not have that many distinct words (0.30
  bits per word too many), and make every shared word twice as likely to be drawn as an unshared
  one. The hint under the slider names the pool size and says how many words were shared.
- Wordlists load via dynamic `import()`, so the password page never pays for the 62 KB large list
  and a visitor who never ticks it never downloads it. Loaded lists are cached per page view.
- The custom separator row is revealed only when the separator select is set to Custom. A typed
  separator is part of the scheme, not a secret, so it contributes **zero** bits — stated on the
  page itself rather than left for the user to assume.
- The shipped default — BIP39 + superheroes, 2,140 distinct words, 6 words plus a digit — is
  **69.7 bits**, which the meter reports as *Fair*. The superhero list alone would be 43.3 bits and
  *Weak*; pairing it with BIP39 is what keeps a memorable default from being a bad one.
- The digit and the symbol land on two *different* words when both are requested.
- Separator and suffix symbol alphabets are separate sets (§8.2).

### 6.3 Shared tool chrome

Both tools get the same shell, from `OutputPanel`, `BulkPanel` and `RangeField`:

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
- **Settings persistence** — every control is saved to `localStorage` (`tt-password`,
  `tt-passphrase-v2`) and restored on the next visit. Output is never stored. A stored value naming
  a wordlist or separator we no longer ship falls back to the default instead of blanking the
  select. **Changing a default means bumping the key**: `loadPrefs` merges defaults under the saved
  object, so returning visitors would otherwise keep the old default forever.

### 6.4 Site-wide

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

### 8.4 Headers

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
npm run verify   # 79 checks, Node, no browser
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
- **Wordlist integrity** — 7,776 and 1,296 entries, all unique, no whitespace.
- **Passphrase composition** — word count, separators, capitalisation modes, digit and symbol
  landing on different words, suffix symbols never colliding with separators, custom separators
  used verbatim and capped in length.
- **Merging** — that the union drops duplicates, equals sum minus overlap, loses no source word,
  invents none, is order-stable across calls, and is unchanged by passing a list twice. BIP39 is
  additionally checked for its defining property: 2,048 words unique in their first four letters.

**Structural passphrase assertions draw from BIP39, deliberately.** They split a phrase on its
separator to count words, and the EFF lists ship four hyphenated entries (`drop-down`, `felt-tip`,
`t-shirt`, `yo-yo`) that break that assumption roughly once in three hundred runs. BIP39 contains
no punctuation at all, so the assertion tests the generator rather than the list. A dedicated check
pins the hyphenated entries so the quirk stays on record.
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
| CSS | 14.7 KB (3.7 KB) | every page |
| Shared logic chunk | 9.7 KB (4.2 KB) | tool pages |
| Theme + prefetch | 2.5 KB (1.1 KB) | every page |
| Password page script | 3.3 KB (1.6 KB) | password page |
| Passphrase page script | 3.0 KB (1.5 KB) | passphrase page |
| Superhero wordlist | 0.9 KB (0.6 KB) | passphrase page, on demand |
| BIP39 English wordlist | 13.2 KB (6.3 KB) | passphrase page, on demand |
| EFF short wordlist | 7.2 KB (3.4 KB) | passphrase page, on demand |
| EFF large wordlist | 62.2 KB (24.6 KB) | passphrase page, on demand |

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
4. **The shared chunk is named `icons.*.js`.** Rollup named it after one of its inputs; it
   actually contains the CSPRNG and UI helpers. Harmless, but misleading in a network tab.
5. **No `modulepreload` for the shared chunk**, so it is a second round trip after the page script.
   Irrelevant at 3.7 KB, worth revisiting if it grows.
6. **CSP allows `'unsafe-inline'` for scripts.** Reasoning in §8.4; the tradeoff is deliberate,
   not an oversight.
7. **No internationalisation.** The UI is English-only, with no structure in place for anything
   else.
8. **Hyphenated words in the EFF lists.** `drop-down`, `felt-tip`, `t-shirt` and `yo-yo` collide
   with the hyphen separator, so such a phrase cannot be split back into its words unambiguously.
   Entropy is unaffected and the words are EFF's own, so nothing is filtered; it is recorded here
   because it surfaced as a flaky test before it was understood.
9. **Planned tools are registry entries only.** Hash, UUID, Base64 and JWT tools have cards and
   nothing behind them.
