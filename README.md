# Technical Toolkit

A static site collecting small developer and security tools. Everything runs client-side —
there is no backend and no database. The only requests the site makes are for its own code from
its own origin, and none of them carries anything you typed.

Live tools: **password generator**, **passphrase generator**, **username generator** (Marvel and
DC hero names), **certificate & CSR generator**,
**hash generator** (MD5/SHA-256/SHA-512), **Base64 encoder/decoder**, **JSON formatter**,
**YAML formatter**, **Unicode text spoofer**, **Unicode escape converter** (\u00f4 to ô),
**epoch converter**, **lunar calendar converter** (âm lịch), **transaction code date decoder**
(tra ngày từ mã giao dịch); a system group: **crontab generator & explainer** (build a schedule,
or paste a crontab and read it in English or Vietnamese, with its next runs), **systemd
OnCalendar explainer** (a timer's schedule normalized exactly as `systemd-analyze` prints it,
with its next runs) and **systemd unit file analyzer** (paste a `.service` or `.timer`, or
`systemctl cat` output with drop-ins, and see every line systemd would ignore or refuse); and a
network group: **subnet calculator**, **IP range to CIDR**, **CIDR aggregator / supernet**,
**CIDR splitter**, **IPv6 calculator** and **byte & throughput converter** (GiB and GB, Mbps
and MB/s, 5 TB over 1 Gbps ≈ 11.1 hours). The two systemd tools and the byte converter are written
in English and Vietnamese, with a switch. Tools are grouped on the home page — Network, Security,
Data formats, Date & time, System, Other.

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
used. The certificate page is 16 KB gzipped, still an order of magnitude below the libraries it
replaces. The systemd unit file analyzer is the largest page, at about 66 KB gzipped with the
OnCalendar library it reads timers with — most of it the parsers ported from systemd and every
message in two languages.

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
absent. The OpenSSL commands the certificate page displays are checked by *running* them: the
script is executed with `sh` and the certificate it produces is compared against the one the page
builds from the same form.

The systemd tools are held to systemd itself. Where `systemd-analyze` can be run — on Linux, or
through WSL on Windows with a distribution that has systemd — the suite puts generated calendar
expressions to `systemd-analyze calendar`, thousands of unit files and drop-ins to
`systemd-analyze verify` and time spans to `systemd-analyze timespan`, and the pages must agree
with it line for line. Without systemd those checks are skipped; pinned answers recorded from
systemd 259 still run.

The unit analyzer's table of directives is generated from systemd's own source. To follow a new
systemd release:

```bash
curl -sSLO https://raw.githubusercontent.com/systemd/systemd/v259/src/core/load-fragment-gperf.gperf.in
npx esbuild scripts/unit-directives.ts --bundle --platform=node --format=esm \
  --outfile=node_modules/.cache/unit-directives.mjs
node node_modules/.cache/unit-directives.mjs load-fragment-gperf.gperf.in v259
```

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
│   ├── random.ts        CSPRNG: unbiased randomInt, shuffle, sample, distinctIndices
│   ├── charsets.ts      Character classes, ambiguous-glyph filter
│   ├── password.ts      generatePassword + option validation
│   ├── passphrase.ts    generatePassphrase + wordlist metadata
│   ├── username.ts      Hero-name usernames: case, spacing, digits, distinct bulk
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
│   ├── openssl.ts       The same form, as a script you could have run instead
│   ├── epoch.ts         Unix time, civil-date maths, time-zone rendering
│   ├── cron.ts          Crontab: parse, describe, next runs across clock changes
│   ├── oncalendar.ts    systemd OnCalendar=, ported from systemd 259's calendarspec.c
│   ├── unitfile.ts      systemd unit files, ported from conf-parser.c and load-fragment.c
│   ├── unitdirectives.ts  Generated: every directive systemd 259 knows (scripts/unit-directives.ts)
│   ├── unitdocs.ts      What the common directives do, in English and Vietnamese
│   ├── timespan.ts      systemd time spans, parsed and printed exactly
│   ├── bytes.ts         Sizes and rates as exact fractions, transfer time
│   ├── lunar.ts         Vietnamese lunar calendar (Hồ Ngọc Đức's algorithm)
│   ├── txcode.ts        Transaction codes that carry a year and a day of year
│   ├── base64.ts        UTF-8-safe encode/decode, standard and URL-safe
│   ├── escape.ts        \uXXXX escape sequences, both directions
│   ├── md5.ts           Hand-written MD5 (WebCrypto will not do it)
│   ├── hash.ts          MD5 + SHA-256/512 over bytes
│   ├── jsonfmt.ts       Format/minify/sort, with an engine-independent
│   │                    error locator
│   ├── yamlfmt.ts       Tidy YAML and convert to/from JSON (lazy js-yaml)
│   ├── format.ts        Shared result type, line/column, deep key sort
│   ├── ui.ts            DOM helpers used by the tool page scripts
│   ├── textio.ts        Wiring for the two-pane text tools
│   ├── lang.ts          The language switch on bilingual pages
│   └── wordlists/       BIP39, superhero and tarot (dynamic import);
│                        Marvel and DC heroes for the username page
├── layouts/             BaseLayout (head/SEO/theme) and ToolLayout
├── components/          Header, Footer, ToolCard, OutputPanel, BulkPanel, Say, LangSwitch…
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

**Two languages on one page.** The systemd tools and the byte converter render every string in
English and Vietnamese and show one; an inline script picks the language before first paint
(`?lang=`, the reader's earlier choice, then the browser's), and the switch under the title
changes it. design.md §5 has the details.

**Entropy is about the generator, not the string.** The figure shown is the size of the space an
attacker searches assuming they know every setting on the page. Pattern-matching scorers like
zxcvbn answer a different question and would understate a genuinely random output.
Where a choice is ambiguous the count is deliberately conservative — the random *position* of an
appended digit or symbol in a passphrase is real entropy that the tool does not claim.

**Certificates are built, not borrowed.** Keys come from `crypto.subtle`; everything wrapped
around them — DER, X.509, PKCS#10, PKCS#12, JKS — is written here, because there is no browser API
for it and the alternative was a dependency far larger than the site. A CA you already have can be
pasted or loaded from a file, PEM or binary DER, and its key is decrypted in the page when it has
a passphrase — PBES2 and OpenSSL's traditional `DEK-Info` PEM both open, while DES, 3DES and RC2
are refused by name because no browser implements them. The sharp edges are recorded
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

Wordlists: the [BIP39 English list](https://github.com/bitcoin/bips/blob/master/bip-0039/english.txt)
(2,048 words), public domain. The 101-word superhero list is the project's own, kept as
`src/lib/wordlists/superhero.txt`, and so is the 78-card tarot list,
`src/lib/wordlists/tarot.ts`. So is the username generator's list of 278 Marvel and DC hero
names, `src/lib/wordlists/heroes.ts`; the names themselves belong to their publishers. Icon
geometry follows [Lucide](https://lucide.dev) (ISC).
