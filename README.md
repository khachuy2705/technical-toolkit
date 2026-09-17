# Technical Toolkit

A static site collecting small developer and security tools. Everything runs client-side —
there is no backend and no database. The only requests the site makes are for its own code from
its own origin, and none of them carries anything you typed.

Live tools: **password generator**, **passphrase generator**, **Base64 encoder/decoder**,
**hash generator** (MD5/SHA-256/SHA-512), **JSON formatter**, **YAML formatter**,
**subnet calculator**, **epoch converter**.

[design.md](design.md) documents the source layout, the layering rule, the full feature catalogue
and the security decisions. Read it before adding a tool.

## Stack

| | |
|---|---|
| Framework | [Astro](https://astro.build) 7, `output: 'static'` |
| Language | TypeScript (strict) |
| Styling | Hand-written CSS with custom properties — no framework |
| Client JS | Vanilla ES modules, bundled per page by Astro |
| Hosting | Vercel (static output, no adapter needed) |

One runtime dependency: `js-yaml`, dynamically imported so only the YAML page downloads it. Every
other tool is written from scratch. A tool page is a few kilobytes of JavaScript; the heavy pieces
— wordlists, the YAML parser — are separate chunks fetched only when the feature is used.

## Commands

```bash
npm install
npm run dev       # dev server
npm run verify    # runs the crypto/entropy checks in scripts/verify.ts
npm run check     # astro check (TypeScript across .astro and .ts)
npm run build     # check + static build into dist/
npm run preview   # serve dist/ locally
```

`npm run verify` is the one to run after touching anything in `src/lib/`. It asserts uniformity of
the RNG over hundreds of thousands of draws, the option constraints, the wordlist integrity, and
the entropy arithmetic.

## Deploying to Vercel

Import the repository; the defaults are already correct (`npm run build` → `dist/`). `vercel.json`
pins them anyway, plus the security headers and long-lived caching for hashed assets.

Set `SITE_URL` in the project's environment variables once a custom domain is attached —
it feeds canonical tags, the sitemap and `robots.txt`. Without it the build falls back to
Vercel's production URL, and then to the placeholder in `src/data/site.ts`.

## Architecture

```
src/
├── data/tools.ts        Tool registry — the single source of truth
├── data/site.ts         Site name, URL, description
├── data/icons.ts        Shared UI icon paths
├── lib/                 Pure logic, no DOM access
│   ├── random.ts        CSPRNG: unbiased randomInt, shuffle, sample
│   ├── charsets.ts      Character classes, ambiguous-glyph filter
│   ├── password.ts      generatePassword + option validation
│   ├── passphrase.ts    generatePassphrase + wordlist metadata
│   ├── entropy.ts       Bits, strength tiers, crack-time phrasing
│   ├── clipboard.ts     Copy with a non-secure-context fallback
│   ├── ipv4.ts          Address parsing and subnet arithmetic
│   ├── epoch.ts         Unix time, civil-date maths, time-zone rendering
│   ├── base64.ts        UTF-8-safe encode/decode, standard and URL-safe
│   ├── md5.ts           Hand-written MD5 (WebCrypto will not do it)
│   ├── hash.ts          MD5 + SHA-256/512 over bytes
│   ├── jsonfmt.ts       Format/minify/sort, with an engine-independent
│   │                    error locator
│   ├── yamlfmt.ts       Tidy YAML and convert to/from JSON (lazy js-yaml)
│   ├── format.ts        Shared result type, line/column, deep key sort
│   ├── ui.ts            DOM helpers used by the tool page scripts
│   ├── textio.ts        Wiring for the two-pane text tools
│   └── wordlists/       BIP39, superhero and EFF short, via dynamic import
├── layouts/             BaseLayout (head/SEO/theme) and ToolLayout
├── components/          Header, Footer, ToolCard, OutputPanel, BulkPanel…
├── pages/
│   ├── index.astro      Grid generated from the registry
│   ├── tools/*.astro    One file per tool
│   └── sitemap.xml.ts   Generated from the registry
└── styles/global.css    Design tokens, light + dark
```

The split that matters: **`src/lib/` never touches the DOM.** It is plain functions that can be
unit-tested in Node, which is what `scripts/verify.ts` does. The page `<script>` blocks are thin
wiring between those functions and the markup.

## Adding a tool

1. Add an entry to `TOOLS` in `src/data/tools.ts` with `status: 'live'`.
2. Create `src/pages/tools/<slug>.astro` using `ToolLayout` with that slug.
3. Put any non-trivial logic in `src/lib/<tool>.ts` as pure functions, and add checks to
   `scripts/verify.ts`.

The home page, the header nav, the "more tools" section and the sitemap pick it up automatically.
Entries with `status: 'planned'` render as a dimmed card and stay out of the sitemap and nav.

## Design notes

**Randomness.** Every random value comes from `crypto.getRandomValues()`. `randomInt` uses
rejection sampling rather than `% n`, which would make low values marginally more likely.
`Math.random()` is never used.

**Entropy is about the generator, not the string.** The figure shown is the size of the space an
attacker searches assuming they know every setting on the page. Pattern-matching scorers like
zxcvbn answer a different question and would understate a genuinely random output.
Where a choice is ambiguous the count is deliberately conservative — the random *position* of an
appended digit or symbol in a passphrase is real entropy that the tool does not claim.

**Content Security Policy.** `script-src` allows `'unsafe-inline'` for one reason: the theme script
in `<head>` must run synchronously before first paint to avoid a white flash, and moving it to a
separate file would cost a blocking round trip. The site renders no user input and loads no
third-party script, so the practical XSS surface is nil. `style-src` needs it for Astro's scoped
styles and a handful of inline `style` attributes.

## Credits

Wordlists: the [EFF short diceware list](https://www.eff.org/dice) (1,296 words) and the
[BIP39 English list](https://github.com/bitcoin/bips/blob/master/bip-0039/english.txt)
(2,048 words), both public domain. The 101-word superhero list is the project's own, kept as
`src/lib/wordlists/superhero.txt`. Icon geometry follows [Lucide](https://lucide.dev) (ISC).
