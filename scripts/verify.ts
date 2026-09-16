import { randomInt, shuffle, sample } from "../src/lib/random";
import { CHAR_CLASSES, AMBIGUOUS_CHARS, stripAmbiguous } from "../src/lib/charsets";
import {
  buildPool,
  generatePassword,
  validatePasswordOptions,
  type PasswordOptions,
} from "../src/lib/password";
import {
  generatePassphrase,
  mergeWordlists,
  separatorById,
  CUSTOM_SEPARATOR_MAX,
  DEFAULT_PASSPHRASE_OPTIONS,
  SEPARATOR_SYMBOLS,
  SUFFIX_SYMBOLS,
  WORDLISTS,
  type PassphraseOptions,
} from "../src/lib/passphrase";
import { EFF_LARGE } from "../src/lib/wordlists/eff-large";
import { EFF_SHORT } from "../src/lib/wordlists/eff-short";
import { SUPERHERO } from "../src/lib/wordlists/superhero";
import { BIP39_EN } from "../src/lib/wordlists/bip39-en";
import {
  passwordEntropy,
  passphraseEntropy,
  classifyStrength,
  crackTime,
} from "../src/lib/entropy";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

console.log("\n-- randomInt --");
{
  const counts = new Array(6).fill(0);
  const N = 600_000;
  for (let i = 0; i < N; i += 1) counts[randomInt(6)] += 1;
  const expected = N / 6;
  const maxDeviation = Math.max(...counts.map((c) => Math.abs(c - expected) / expected));
  check("stays in range", counts.every((c) => c > 0));
  check(`uniform within 2% (worst ${(maxDeviation * 100).toFixed(2)}%)`, maxDeviation < 0.02, String(counts));
  check("randomInt(1) === 0", Array.from({ length: 50 }, () => randomInt(1)).every((v) => v === 0));
  let threw = false;
  try { randomInt(0); } catch { threw = true; }
  check("randomInt(0) throws", threw);
}

console.log("\n-- shuffle --");
{
  const positions = new Array(5).fill(0);
  const N = 120_000;
  for (let i = 0; i < N; i += 1) positions[shuffle([0, 1, 2, 3, 4]).indexOf(0)] += 1;
  const expected = N / 5;
  const worst = Math.max(...positions.map((c) => Math.abs(c - expected) / expected));
  check(`element 0 lands uniformly (worst ${(worst * 100).toFixed(2)}%)`, worst < 0.03, String(positions));
  check("preserves members", shuffle([1, 2, 3, 4, 5]).sort().join() === "1,2,3,4,5");
}

console.log("\n-- charsets --");
{
  check("ambiguous set parsed intact", AMBIGUOUS_CHARS.includes("\\") && AMBIGUOUS_CHARS.includes('"') && AMBIGUOUS_CHARS.includes("'"));
  check("stripAmbiguous removes O and 0", !stripAmbiguous("O0abc").includes("0"));
  check("full pool is 26+26+10+28", CHAR_CLASSES.reduce((n, c) => n + c.chars.length, 0) === 90, String(CHAR_CLASSES.map((c) => c.chars.length)));
  check("no duplicate chars within a class", CHAR_CLASSES.every((c) => new Set(c.chars).size === c.chars.length));
}

console.log("\n-- password --");
{
  const base: PasswordOptions = {
    length: 20,
    classes: ["lowercase", "uppercase", "digits", "symbols"],
    excludeAmbiguous: false,
    noRepeats: false,
    requireEachClass: true,
  };

  check("pool size with all classes", buildPool(base).length === 90, String(buildPool(base).length));

  for (const length of [6, 20, 64, 128]) {
    const pw = generatePassword({ ...base, length });
    check(`length ${length}`, pw.length === length, `got ${pw.length}`);
  }

  // Every class present, across many draws.
  let allClassesEveryTime = true;
  for (let i = 0; i < 2000; i += 1) {
    const pw = generatePassword({ ...base, length: 8 });
    for (const cls of CHAR_CLASSES) {
      if (![...pw].some((c) => cls.chars.includes(c))) allClassesEveryTime = false;
    }
  }
  check("requireEachClass holds over 2000 draws", allClassesEveryTime);

  // Position must not encode class: first char should not always be lowercase.
  const firstIsLower = Array.from({ length: 4000 }, () => generatePassword({ ...base, length: 8 })[0]!)
    .filter((c) => /[a-z]/.test(c)).length / 4000;
  check(`first char is lowercase ~29% of the time (${(firstIsLower * 100).toFixed(1)}%)`, firstIsLower > 0.2 && firstIsLower < 0.4);

  const noRepeat = generatePassword({ ...base, length: 60, noRepeats: true });
  check("noRepeats yields all-distinct chars", new Set(noRepeat).size === 60, `${new Set(noRepeat).size}/60`);

  const noAmbig = Array.from({ length: 300 }, () => generatePassword({ ...base, length: 40, excludeAmbiguous: true })).join("");
  check("excludeAmbiguous removes every listed glyph", ![...noAmbig].some((c) => AMBIGUOUS_CHARS.includes(c)));

  check("rejects empty class list", validatePasswordOptions({ ...base, classes: [] }) !== null);
  check("rejects noRepeats beyond pool", validatePasswordOptions({ ...base, length: 100, noRepeats: true }) !== null);
  check("rejects length < class count", validatePasswordOptions({ ...base, length: 3 }) !== null);
  check("accepts a sane config", validatePasswordOptions(base) === null);

  const lowerOnly = generatePassword({ ...base, classes: ["lowercase"], length: 30 });
  check("single class stays in that class", /^[a-z]{30}$/.test(lowerOnly), lowerOnly);
}

console.log("\n-- wordlists --");
{
  const lists = [...EFF_LARGE, ...EFF_SHORT, ...SUPERHERO, ...BIP39_EN];
  check("EFF large has 7776 unique words", EFF_LARGE.length === 7776 && new Set(EFF_LARGE).size === 7776);
  check("EFF short has 1296 unique words", EFF_SHORT.length === 1296 && new Set(EFF_SHORT).size === 1296);
  check("superhero has 101 unique words", SUPERHERO.length === 101 && new Set(SUPERHERO).size === 101, String(SUPERHERO.length));
  check("BIP39 has 2048 unique words", BIP39_EN.length === 2048 && new Set(BIP39_EN).size === 2048, String(BIP39_EN.length));
  check(
    "BIP39 words are unique in their first four letters",
    new Set(BIP39_EN.map((w) => w.slice(0, 4))).size === 2048,
  );
  check("no empty entries", lists.every((w) => w.length > 0));
  check("no whitespace inside words", lists.every((w) => !/\s/.test(w)));
  check("superhero words are plain lowercase", SUPERHERO.every((w) => /^[a-z]+$/.test(w)));
  check("BIP39 words are plain lowercase", BIP39_EN.every((w) => /^[a-z]+$/.test(w)));

  // The registry advertises a size next to every list; a mismatch would print a
  // bits-per-word figure that does not describe what is actually drawn.
  const sizes = [
    ["eff-large", EFF_LARGE.length],
    ["eff-short", EFF_SHORT.length],
    ["superhero", SUPERHERO.length],
    ["bip39-en", BIP39_EN.length],
  ] as const;
  check(
    "registry sizes match the loaded lists",
    sizes.every(([id, size]) => WORDLISTS.find((w) => w.id === id)?.size === size),
    JSON.stringify(WORDLISTS.map((w) => [w.id, w.size])),
  );
}

console.log("\n-- passphrase --");
{
  // Structural tests pin the list and drop the extras so the assertions below
  // describe one thing at a time; the shipped defaults are checked separately.
  const base: PassphraseOptions = {
    ...DEFAULT_PASSPHRASE_OPTIONS,
    wordlistIds: ["bip39-en"],
    includeNumber: false,
  };

  for (const wordCount of [3, 6, 15]) {
    const phrase = generatePassphrase(BIP39_EN, { ...base, wordCount });
    // Exact, not `>=`: BIP39 carries no hyphens, so the split can only yield
    // more parts than words if the generator emitted a stray separator.
    check(`${wordCount} words joined by ${wordCount - 1} hyphens`, phrase.split("-").length === wordCount, phrase);
  }

  const titled = generatePassphrase(BIP39_EN, { ...base, capitalization: "title" });
  check("title case capitalises every word", titled.split("-").every((w) => /^[A-Z]/.test(w)), titled);

  const oneUpper = Array.from({ length: 200 }, () =>
    generatePassphrase(BIP39_EN, { ...base, capitalization: "random-word", separator: "dash" }),
  );
  check(
    "random-word uppercases exactly one word",
    oneUpper.every((p) => p.split("-").filter((w) => w === w.toUpperCase() && /[A-Z]/.test(w)).length === 1),
  );

  const digitSep = generatePassphrase(BIP39_EN, { ...base, separator: "digit", wordCount: 6 });
  check("digit separator inserts digits", (digitSep.match(/\d/g) ?? []).length >= 5, digitSep);

  const none = generatePassphrase(BIP39_EN, { ...base, separator: "none", wordCount: 4 });
  check("separator none produces one run of letters", /^[a-z]+$/.test(none), none);

  const both = Array.from({ length: 200 }, () =>
    generatePassphrase(EFF_SHORT, { ...base, includeNumber: true, includeSymbol: true, wordCount: 5 }),
  );
  const suffixSymbol = new RegExp(`[${SUFFIX_SYMBOLS.replace(/[$^]/g, "\$&")}]`);
  check("digit and symbol both appear when requested", both.every((p) => /\d/.test(p) && suffixSymbol.test(p)), both.find((p) => !suffixSymbol.test(p)) ?? both[0]);
  check(
    "digit and symbol land on different words",
    both.every((p) => p.split("-").filter((w) => /\d$/.test(w) || suffixSymbol.test(w.slice(-1))).length === 2),
    both[0],
  );
  check(
    "no suffix symbol doubles as a separator",
    ![...SUFFIX_SYMBOLS].some((c) => "-_. ".includes(c)),
  );
  check("separator symbol set is 13 wide", SEPARATOR_SYMBOLS.length === 13);

  const custom = generatePassphrase(BIP39_EN, {
    ...base,
    separator: "custom",
    customSeparator: "::",
    wordCount: 4,
  });
  check("custom separator is used verbatim", custom.split("::").length === 4, custom);
  check("custom separator kind is not random", separatorById("custom").kind === "custom");

  const overlong = generatePassphrase(BIP39_EN, {
    ...base,
    separator: "custom",
    customSeparator: "x".repeat(CUSTOM_SEPARATOR_MAX + 5),
    wordCount: 3,
  });
  check(
    `custom separator is capped at ${CUSTOM_SEPARATOR_MAX}`,
    overlong.split("x".repeat(CUSTOM_SEPARATOR_MAX)).length === 3 && !overlong.includes("x".repeat(CUSTOM_SEPARATOR_MAX + 1)),
    overlong,
  );

  const emptyCustom = generatePassphrase(BIP39_EN, {
    ...base,
    separator: "custom",
    customSeparator: "",
    wordCount: 4,
  });
  check("empty custom separator still generates", /^[a-z]+$/.test(emptyCustom), emptyCustom);

  // Documented quirk, not a bug: the EFF lists ship hyphenated entries, so a
  // hyphen-separated phrase drawn from them cannot be split back into words.
  // Entropy is unaffected; this check exists so the surprise stays on record —
  // and it is why the assertions above draw from BIP39, which has no punctuation.
  const hyphenated = EFF_LARGE.filter((w) => w.includes("-"));
  check(
    "EFF large still holds exactly 4 hyphenated words",
    hyphenated.length === 4,
    JSON.stringify(hyphenated),
  );
  check(
    "BIP39 and superhero carry no punctuation",
    [...BIP39_EN, ...SUPERHERO].every((w) => /^[a-z]+$/.test(w)),
  );

  const superheroPhrase = generatePassphrase(SUPERHERO, { ...base, wordCount: 5 });
  check(
    "superhero phrase uses only superhero words",
    superheroPhrase.split("-").every((w) => SUPERHERO.includes(w)),
    superheroPhrase,
  );

  const drawn = sample(BIP39_EN, 5000);
  check("words come from the list", drawn.every((w) => BIP39_EN.includes(w)));
  check("consecutive phrases differ", generatePassphrase(BIP39_EN, base) !== generatePassphrase(BIP39_EN, base));
}

console.log("\n-- merging wordlists --");
{
  const merged = mergeWordlists([BIP39_EN, SUPERHERO]);
  const shared = BIP39_EN.filter((w) => new Set(SUPERHERO).has(w));

  check("merge drops duplicates", new Set(merged).size === merged.length, String(merged.length));
  check(
    "merged size is the union, not the sum",
    merged.length === BIP39_EN.length + SUPERHERO.length - shared.length,
    `${merged.length} vs ${BIP39_EN.length}+${SUPERHERO.length}-${shared.length}`,
  );
  check("every source word survives", [...BIP39_EN, ...SUPERHERO].every((w) => merged.includes(w)));
  check("merge introduces nothing", merged.every((w) => BIP39_EN.includes(w) || SUPERHERO.includes(w)));
  check("order is stable across calls", mergeWordlists([BIP39_EN, SUPERHERO]).join() === merged.join());
  check("a repeated list changes nothing", mergeWordlists([BIP39_EN, SUPERHERO, BIP39_EN]).join() === merged.join());
  check("merging one list is a no-op", mergeWordlists([SUPERHERO]).join() === SUPERHERO.join());
  check("merging nothing is empty", mergeWordlists([]).length === 0);

  const phrase = generatePassphrase(merged, { ...DEFAULT_PASSPHRASE_OPTIONS, includeNumber: false });
  check("a merged pool generates", phrase.split("-").every((w) => merged.includes(w)), phrase);

  // The overlap is the whole reason merge exists: naive concatenation would
  // claim log2(sum) bits and make shared words twice as likely to be drawn.
  const all = mergeWordlists([BIP39_EN, SUPERHERO, EFF_LARGE, EFF_SHORT]);
  const naive = BIP39_EN.length + SUPERHERO.length + EFF_LARGE.length + EFF_SHORT.length;
  console.log(
    `     all four lists: ${all.length} distinct of ${naive} raw — naive concat would overstate by ${(Math.log2(naive) - Math.log2(all.length)).toFixed(2)} bits/word`,
  );
}

console.log("\n-- entropy --");
{
  check("20 chars from a 90-char pool = 129.8 bits", Math.abs(passwordEntropy(90, 20) - 129.83) < 0.01, passwordEntropy(90, 20).toFixed(2));
  const plain: PassphraseOptions = { ...DEFAULT_PASSPHRASE_OPTIONS, includeNumber: false };
  check("6 EFF-large words = 77.5 bits", Math.abs(passphraseEntropy(plain, 7776) - 77.55) < 0.01, passphraseEntropy(plain, 7776).toFixed(2));
  check("6 EFF-short words = 62.0 bits", Math.abs(passphraseEntropy(plain, 1296) - 62.04) < 0.01);
  check("6 superhero words = 39.9 bits", Math.abs(passphraseEntropy(plain, 101) - 39.95) < 0.01, passphraseEntropy(plain, 101).toFixed(2));
  check("6 BIP39 words = 66.0 bits", Math.abs(passphraseEntropy(plain, 2048) - 66) < 0.01, passphraseEntropy(plain, 2048).toFixed(2));

  // A typed separator is part of the scheme, not a secret.
  const typed = passphraseEntropy({ ...plain, separator: "custom", customSeparator: "::" }, 7776);
  check("custom separator adds no bits", Math.abs(typed - passphraseEntropy(plain, 7776)) < 1e-9, typed.toFixed(2));

  const withDigitSep = passphraseEntropy({ ...plain, separator: "digit" }, 7776);
  check("random digit separators add ~16.6 bits", Math.abs(withDigitSep - 77.55 - 16.61) < 0.05, withDigitSep.toFixed(2));

  check("empty pool scores 0", passwordEntropy(1, 20) === 0 && passwordEntropy(90, 0) === 0);

  const levels = [20, 40, 60, 80, 130].map((b) => classifyStrength(b));
  check("tiers ascend", levels.map((l) => l.level).join() === "0,1,2,3,4", levels.map((l) => `${l.level}:${l.label}`).join(" "));
  check("boundary 36 is Weak", classifyStrength(36).label === "Weak");
  check("boundary 96 is Excellent", classifyStrength(96).label === "Excellent");

  console.log(`     crack times: 20b=${crackTime(20)} | 40b=${crackTime(40)} | 60b=${crackTime(60)} | 77.5b=${crackTime(77.55)} | 129.8b=${crackTime(129.83)} | 838b=${crackTime(838)}`);
  check("0 bits is instant", crackTime(0) === "instantly");
  check("high entropy is finite text", !crackTime(838).includes("NaN") && !crackTime(838).includes("Infinity"));
  check("129.8 bits is astronomically long", crackTime(129.83).includes("year"));
}

console.log("\n-- shipped defaults --");
{
  const d = DEFAULT_PASSPHRASE_OPTIONS;
  check(
    "passphrase defaults to BIP39 + superhero",
    d.wordlistIds.join(",") === "bip39-en,superhero",
    d.wordlistIds.join(","),
  );
  check("passphrase appends a digit by default", d.includeNumber === true);

  // Printed, not asserted: the default trades strength for memorability, and
  // this line is where that trade stays visible on every run.
  const pool = mergeWordlists([BIP39_EN, SUPERHERO]);
  const bits = passphraseEntropy(d, pool.length);
  console.log(
    `     default: ${generatePassphrase(pool, d)}  →  ${bits.toFixed(1)} bits, ${classifyStrength(bits).label}, cracked in ${crackTime(bits)}`,
  );
}

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
