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
  DEFAULT_PASSPHRASE_OPTIONS,
  SEPARATOR_SYMBOLS,
  SUFFIX_SYMBOLS,
  type PassphraseOptions,
} from "../src/lib/passphrase";
import { EFF_LARGE } from "../src/lib/wordlists/eff-large";
import { EFF_SHORT } from "../src/lib/wordlists/eff-short";
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
  check("EFF large has 7776 unique words", EFF_LARGE.length === 7776 && new Set(EFF_LARGE).size === 7776);
  check("EFF short has 1296 unique words", EFF_SHORT.length === 1296 && new Set(EFF_SHORT).size === 1296);
  check("no empty entries", [...EFF_LARGE, ...EFF_SHORT].every((w) => w.length > 0));
  check("no whitespace inside words", [...EFF_LARGE, ...EFF_SHORT].every((w) => !/\s/.test(w)));
}

console.log("\n-- passphrase --");
{
  const base: PassphraseOptions = { ...DEFAULT_PASSPHRASE_OPTIONS };

  for (const wordCount of [3, 6, 15]) {
    const phrase = generatePassphrase(EFF_LARGE, { ...base, wordCount });
    check(`${wordCount} words joined by ${wordCount - 1} hyphens`, phrase.split("-").length >= wordCount, phrase);
  }

  const titled = generatePassphrase(EFF_LARGE, { ...base, capitalization: "title" });
  check("title case capitalises every word", titled.split("-").every((w) => /^[A-Z]/.test(w)), titled);

  const oneUpper = Array.from({ length: 200 }, () =>
    generatePassphrase(EFF_LARGE, { ...base, capitalization: "random-word", separator: "dash" }),
  );
  check(
    "random-word uppercases exactly one word",
    oneUpper.every((p) => p.split("-").filter((w) => w === w.toUpperCase() && /[A-Z]/.test(w)).length === 1),
  );

  const digitSep = generatePassphrase(EFF_LARGE, { ...base, separator: "digit", wordCount: 6 });
  check("digit separator inserts digits", (digitSep.match(/\d/g) ?? []).length >= 5, digitSep);

  const none = generatePassphrase(EFF_LARGE, { ...base, separator: "none", wordCount: 4 });
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

  const drawn = sample(EFF_LARGE, 5000);
  check("words come from the list", drawn.every((w) => EFF_LARGE.includes(w)));
  check("consecutive phrases differ", generatePassphrase(EFF_LARGE, base) !== generatePassphrase(EFF_LARGE, base));
}

console.log("\n-- entropy --");
{
  check("20 chars from a 90-char pool = 129.8 bits", Math.abs(passwordEntropy(90, 20) - 129.83) < 0.01, passwordEntropy(90, 20).toFixed(2));
  check("6 EFF-large words = 77.5 bits", Math.abs(passphraseEntropy({ ...DEFAULT_PASSPHRASE_OPTIONS }, 7776) - 77.55) < 0.01, passphraseEntropy({ ...DEFAULT_PASSPHRASE_OPTIONS }, 7776).toFixed(2));
  check("6 EFF-short words = 62.0 bits", Math.abs(passphraseEntropy({ ...DEFAULT_PASSPHRASE_OPTIONS }, 1296) - 62.04) < 0.01);

  const withDigitSep = passphraseEntropy({ ...DEFAULT_PASSPHRASE_OPTIONS, separator: "digit" }, 7776);
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

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
