# Technical Toolkit

A static site collecting small developer and security tools. Everything runs client-side —
there is no backend and no database. The only requests the site makes are for its own code from
its own origin, and none of them carries anything you typed.

Live tools: **password generator**, **passphrase generator**, **certificate & CSR generator**,
**hash generator** (MD5/SHA-256/SHA-512), **Base64 encoder/decoder**, **JSON formatter**,
**YAML formatter**, **epoch converter**, **lunar calendar converter** (âm lịch), and a network
group: **subnet calculator**, **IP range to CIDR**, **CIDR aggregator / supernet**, **CIDR
splitter** and **IPv6 calculator**. Tools are grouped on the home page — Network, Security, Data
formats, Date & time.

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
other tool is written from scratch, including the whole certificate stack — ASN.1/DER, X.509,
PKCS#10, PKCS#12 and the Java keystore format. A tool page is a few kilobytes of JavaScript; the
heavy pieces — wordlists, the YAML parser — are separate chunks fetched only when the feature is
used. The certificate page is the largest at 12.8 KB gzipped, still an order of magnitude below
the libraries it replaces.

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
the entropy arithmetic. For the certificate tools it leans on outside readers rather than on
itself: every generated certificate is parsed and its signature verified by Node's
`X509Certificate`, and where `openssl` is on PATH it parses the certificate and the CSR and opens
the PKCS#12 with its own password derivation. OpenSSL is optional — those checks skip when it is
absent.

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
│   ├── ipv6.ts          IPv6 parsing, RFC 5952 formatting, address types
│   ├── iprange.ts       Range to CIDR, aggregation, supernet, splitting (IPv4 + IPv6)
│   ├── asn1.ts          DER encoder and reader
│   ├── pem.ts           PEM encode/decode, forgiving about pasted text
│   ├── keys.ts          WebCrypto key generation, import and signing
│   ├── x509.ts          Distinguished names, SANs, purposes, certificates, CSRs
│   ├── pkcs12.ts        .p12 keystores — PBES2 key, RFC 7292 MAC
│   ├── jks.ts           .jks keystores — Sun's legacy Java format
│   ├── certgen.ts       One form in, one bundle of files out
│   ├── epoch.ts         Unix time, civil-date maths, time-zone rendering
│   ├── lunar.ts         Vietnamese lunar calendar (Hồ Ngọc Đức's algorithm)
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

**Certificates are built, not borrowed.** Keys come from `crypto.subtle`; everything wrapped
around them — DER, X.509, PKCS#10, PKCS#12, JKS — is written here, because there is no browser API
for it and the alternative was a dependency far larger than the site. The sharp edges are recorded
in [design.md](design.md) §8.6: ECDSA signatures need reshaping from WebCrypto's raw `r || s` into
DER, an ECDSA certificate must never claim `keyEncipherment`, a root CA must carry no EKU, and a
.p12 needs two different key derivations because its MAC predates PBKDF2's use here. A CA made on
the page lives in memory for the tab and is never written to storage.

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
