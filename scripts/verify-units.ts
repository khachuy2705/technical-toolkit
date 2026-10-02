/**
 * Checks for the unit file analyzer, `src/lib/unitfile.ts`, and the time
 * spans it reads with `src/lib/timespan.ts`.
 *
 * - **Pinned cases**, asserted on every run: what the analyzer says, line by
 *   line, about unit files with the mistakes people make — typos, a drop-in
 *   that forgets to clear ExecStart=, `date +%F` in a command line, a timer
 *   with no [Install] — in both languages.
 * - **systemd itself**, where `systemd-analyze` can be run (Linux, or WSL on
 *   Windows): every directive systemd knows, with values good and bad, then
 *   generated whole files and drop-ins, go to `systemd-analyze verify`, and
 *   systemd and the analyzer must agree on which lines it complains about, how
 *   loudly, and whether the unit loads at all. Time spans go to
 *   `systemd-analyze timespan`. Without systemd these are skipped.
 */

import { analyzeUnits, directivesOf, type Finding, type UnitAnalysis } from "../src/lib/unitfile";
import { formatTimespan, parseTimespan, parseTimespanExact } from "../src/lib/timespan";
import { findSystemd, seeded } from "./verify-systemd";
import type { Check } from "./verify-tools";

/* -------------------------------------------------------------- pinned */

interface Pinned {
  readonly label: string;
  readonly name: string | null;
  readonly text: string;
  /** Every finding, as "line severity source", line "-" for the unit as a whole. */
  readonly findings: readonly string[];
  readonly refused?: boolean;
  /** Fixes the analyzer must offer, by line. */
  readonly fixes?: readonly (readonly [number | null, string])[];
}

const PINNED: readonly Pinned[] = [
  {
    label: "typos in keys, values and a section name",
    name: "backup.service",
    text: "[Unit]\nDescription=Nightly backup\nAfter=network\n\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/backup.sh\nRestart=allways\nRestartSec=5 minuts\nUser=backup\nEnviroment=TARGET=/srv\n\n[install]\nWantedBy=multi-user\n",
    findings: ["3 warning line", "8 warning line", "9 warning line", "11 warning line", "13 warning line", "- note advice"],
    fixes: [
      [3, "After=network.target"],
      [8, "Restart=always"],
      [11, "Environment=TARGET=/srv"],
      [13, "[Install]"],
    ],
  },
  {
    label: "date formats in a command line",
    name: "report.service",
    text: "[Service]\nType=oneshot\nExecStart=/bin/date +%Y-%m-%d\nExecStart=/bin/sh -c 'date +%F >> /var/log/x'\nExecStartPost=/usr/bin/logger done > /dev/null\n",
    findings: ["3 warning advice", "4 error line", "- note advice"],
    refused: true,
    fixes: [[3, "ExecStart=/bin/date +%%Y-%%m-%%d"]],
  },
  {
    label: "a drop-in that adds a second ExecStart=",
    name: null,
    text: "# /etc/systemd/system/web.service\n[Unit]\nDescription=Web\n\n[Service]\nExecStart=/usr/bin/web --port 80\n\n# /etc/systemd/system/web.service.d/override.conf\n[Service]\nExecStart=/usr/bin/web --port 8080\n",
    findings: ["10 error unit", "- note advice"],
    refused: true,
    fixes: [[10, "ExecStart=\nExecStart=/usr/bin/web --port 8080"]],
  },
  {
    label: "a drop-in that clears ExecStart= first",
    name: null,
    text: "# /etc/systemd/system/web.service\n[Unit]\nDescription=Web\n\n[Service]\nExecStart=/usr/bin/web --port 80\n\n# /etc/systemd/system/web.service.d/override.conf\n[Service]\nExecStart=\nExecStart=/usr/bin/web --port 8080\n",
    findings: ["10 note advice", "- note advice"],
  },
  {
    label: "a timer with no [Install]",
    name: "backup.timer",
    text: "[Unit]\nDescription=Backup timer\n\n[Timer]\nOnCalendar=Mon..Fri *-*-* 08:30:00\nPersistent=true\n",
    findings: ["- warning advice"],
  },
  {
    label: "a timer whose triggers are all refused",
    name: "t.timer",
    text: "[Timer]\nOnCalendar=*-*-* 25:00\nOnBootSec=5x\nPersistent=yes\n[Install]\nWantedBy=multi-user.target\n",
    findings: ["2 warning line", "3 warning line", "4 note advice", "6 note advice", "- error unit"],
    refused: true,
    fixes: [[6, "WantedBy=timers.target"]],
  },
  {
    label: "a service and a timer pasted one after the other",
    name: null,
    text: "[Unit]\nDescription=Job\n[Service]\nExecStart=/usr/bin/job\n[Install]\nWantedBy=multi-user.target\n[Unit]\nDescription=Job timer\n[Timer]\nOnUnitActiveSec=1h\n",
    findings: ["10 warning advice", "- warning advice"],
  },
  {
    label: "network-online.target, half wired",
    name: "n.service",
    text: "[Unit]\nWants=network-online.target\nAfter=network.target\nRequires=db.service\n[Service]\nExecStart=/usr/bin/app\n",
    findings: ["2 warning advice", "4 note advice", "- note advice"],
    fixes: [[2, "After=network-online.target"]],
  },
  {
    label: "sizes, percentages, limits, directories, capabilities, signals",
    name: "m.service",
    text: "[Service]\nExecStart=/bin/true\nMemoryMax=1GB\nCPUQuota=50\nLimitNOFILE=4096:1024\nStateDirectory=/var/lib/app\nCapabilityBoundingSet=CAP_NET_BIND\nKillSignal=sigterm\nTimeoutStopSec=5Min\n",
    findings: ["3 warning line", "4 warning line", "5 warning line", "6 warning line", "7 warning advice", "8 warning line", "9 warning line", "- note advice"],
    fixes: [
      [3, "MemoryMax=1G"],
      [4, "CPUQuota=50%"],
      [5, "LimitNOFILE=1024:4096"],
      [6, "StateDirectory=app"],
      [7, "CapabilityBoundingSet=CAP_NET_BIND_SERVICE"],
      [8, "KillSignal=SIGTERM"],
    ],
  },
  {
    label: "shell syntax and sudo",
    name: "s.service",
    text: "[Service]\nExecStart=/usr/bin/app --log /tmp/a.log 2>&1 &\nExecStart=sudo /usr/bin/app\n",
    findings: ["2 warning advice", "3 error unit", "3 note advice", "- note advice"],
    refused: true,
  },
  {
    label: "a stray line and a broken header",
    name: "s.service",
    text: "Description=stray\n[Unit\nDescription=x\n",
    findings: ["1 warning line", "2 error line", "- note advice"],
    refused: true,
  },
  {
    label: "users systemd takes, and one it frowns on",
    name: "u.service",
    text: "[Service]\nExecStart=/bin/true\nUser=nobody\nGroup=my group\n",
    findings: ["3 warning line", "4 note advice", "- note advice"],
  },
  {
    label: "unit names without a suffix, links without a scheme",
    name: "d.service",
    text: "[Unit]\nAfter=network multi-user.target foo\nDocumentation=example.com man:foo(1)\n[Service]\nExecStart=/bin/true\nSlice=apps\n",
    findings: ["2 warning line", "2 warning line", "3 warning line", "6 warning line", "- note advice"],
    fixes: [
      [3, "Documentation=https://example.com man:foo(1)"],
      [6, "Slice=apps.slice"],
    ],
  },
  {
    label: "a misspelt key, a key in the wrong section, a removed one",
    name: "k.service",
    text: "[Unit]\nDescription=x\n[Service]\nExecStartt=/bin/true\nRequires=db.service\nMemoryLimit=1G\nKillMode=none\nStandardOutput=syslog\nX-Owner=me\n.include /etc/common.conf\n",
    findings: ["4 warning line", "5 warning line", "6 warning line", "7 warning line", "8 note line", "9 note advice", "10 warning line", "- error unit", "- note advice"],
    refused: true,
    fixes: [
      [4, "ExecStart=/bin/true"],
      [7, "KillMode=mixed"],
      [8, "StandardOutput=journal"],
    ],
  },
  {
    label: "values that stop the unit loading",
    name: "f.service",
    text: "[Service]\nExecStart=/bin/true\nDynamicUser=maybe\n",
    findings: ["3 error line", "- note advice"],
    refused: true,
  },
  {
    label: "WorkingDirectory=, with and without the dash",
    name: "w.service",
    text: "[Service]\nExecStart=/bin/true\nWorkingDirectory=-srv\nWorkingDirectory=srv\n",
    findings: ["3 warning line", "4 error line", "- note advice"],
    refused: true,
  },
  {
    label: "service_verify(): D-Bus without a name, restarts without a pause",
    name: "b.service",
    text: "[Service]\nType=dbus\nExecStart=/usr/bin/app\nRestart=always\n",
    findings: ["2 error unit", "4 note advice", "- note advice"],
    refused: true,
    fixes: [[4, "RestartSec=5s"]],
  },
  {
    label: "[Install] names that systemctl enable refuses",
    name: "i.service",
    text: "[Service]\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user\n",
    findings: ["4 warning advice"],
    fixes: [[4, "WantedBy=multi-user.target"]],
  },
  {
    label: "a step systemd 259 mishandles",
    name: "c.timer",
    text: "[Timer]\nOnCalendar=*:0/7\n[Install]\nWantedBy=timers.target\n",
    findings: ["2 warning advice"],
  },
  {
    label: "environment assignments",
    name: "e.service",
    text: '[Service]\nExecStart=/bin/true\nEnvironment="GREETING=hello world" LANG=C\nEnvironment=GREETING=hello world\nEnvironment=%F=1\n',
    findings: ["4 warning line", "5 warning line", "- note advice"],
  },
  {
    label: "specifiers outside command lines",
    name: "p.service",
    text: "[Unit]\nDescription=Backup of %H at 100%\n[Service]\nExecStart=/bin/true\n",
    findings: ["- note advice"],
  },
  {
    label: "an unknown specifier in a description",
    name: "p.service",
    text: "[Unit]\nDescription=Backup %F\n[Service]\nExecStart=/bin/true\n",
    findings: ["2 warning line", "- note advice"],
    fixes: [[2, "Description=Backup %%F"]],
  },
];

function pinnedChecks(check: Check): void {
  console.log("\n-- unit files: findings line by line, pinned --");
  const all: Finding[] = [];
  for (const pinned of PINNED) {
    const analysis = analyzeUnits(pinned.text, pinned.name);
    all.push(...analysis.findings);
    const got = analysis.findings.map((f) => `${f.line ?? "-"} ${f.severity} ${f.source}`).sort();
    const want = [...pinned.findings].sort();
    check(pinned.label, got.join(" | ") === want.join(" | "), `got ${got.join(", ")}; want ${want.join(", ")}`);
    const refused = analysis.units.some((unit) => unit.refused);
    if (refused !== (pinned.refused ?? false)) check(`${pinned.label}: refused`, false, `refused ${refused}`);
    for (const [line, fix] of pinned.fixes ?? []) {
      const offered = analysis.findings.filter((f) => f.line === line).map((f) => f.fix);
      check(`${pinned.label}: line ${line ?? "-"} offers ${JSON.stringify(fix)}`, offered.includes(fix), JSON.stringify(offered));
    }
  }

  {
    const analysis = analyzeUnits("[Service]\nExecStart=/bin/echo a \\", "c.service");
    const entry = analysis.files[0]!.entries[0]!;
    check("a continuation the file never finishes is numbered one past the end, as systemd does", entry.line === 2 && entry.systemdLine === 3, `${entry.line}/${entry.systemdLine}`);
    const continued = analyzeUnits("[Service]\nExecStart=/bin/echo a \\\n# a comment inside\n  b\nFoo=1\n", "c.service");
    check(
      "comments inside a continued line are skipped, and the line is read whole",
      continued.files[0]!.entries[0]!.value === "/bin/echo a    b" && continued.findings.some((f) => f.line === 5 && f.source === "line"),
      JSON.stringify(continued.files[0]!.entries[0]!.value),
    );
  }
  {
    const cat = analyzeUnits(
      "# /etc/systemd/system/app.service\n[Service]\nExecStart=/usr/bin/app\n\n# /etc/systemd/system/app.service.d/10-limits.conf\n[Service]\nLimitNOFILE=65536\n\n# /etc/systemd/system/app.timer\n[Timer]\nOnCalendar=daily\n[Install]\nWantedBy=timers.target\n",
    );
    check(
      "systemctl cat output splits into files, and drop-ins join their unit",
      cat.files.length === 3 && cat.units.length === 2 && cat.units[0]!.files.length === 2 && cat.files[1]!.dropIn,
      `${cat.files.length} files, ${cat.units.length} units`,
    );
  }

  console.log("\n-- unit files: every finding in both languages --");
  const missing = all.filter((f) => f.text.en.trim() === "" || f.text.vi.trim() === "" || f.text.en === f.text.vi);
  check(`${all.length} findings, each with its own English and Vietnamese sentence`, missing.length === 0, missing.map((f) => f.text.en).join(" | "));
  const facts = PINNED.flatMap((pinned) => analyzeUnits(pinned.text, pinned.name).units.flatMap((unit) => unit.facts));
  check(`${facts.length} summary facts, each labelled in both languages`, facts.every((fact) => fact.label.en !== "" && fact.label.vi !== "" && fact.value.en !== "" && fact.value.vi !== ""));
}

function timespanChecks(check: Check): void {
  console.log("\n-- time spans: read as systemd's parse_time() reads them --");
  const SPANS: readonly [string, number | null][] = [
    ["5min", 300e6],
    ["5 min", 300e6],
    ["1h 30min", 5400e6],
    ["1h30min", 5400e6],
    ["1.5h", 5400e6],
    ["90", 90e6],
    ["10 20", 30e6],
    ["100ms", 100e3],
    ["2weeks", 1209600e6],
    ["1M", 2629800e6],
    ["1y", 31557600e6],
    ["infinity", Number.POSITIVE_INFINITY],
    ["  infinity  ", Number.POSITIVE_INFINITY],
    ["0", 0],
    ["", null],
    ["5Min", null],
    ["5 minuts", null],
    ["-5s", null],
    ["12.34.56", null],
    ["1.", null],
    ["5x", null],
    ["infinity5", null],
  ];
  for (const [text, want] of SPANS) {
    const got = parseTimespan(text);
    check(`${JSON.stringify(text)} → ${want === null ? "refused" : want}`, got === want, String(got));
  }
  check("nanoseconds where the setting counts them: 50ns, 1us", parseTimespan("50ns", "ns") === 50 && parseTimespan("1us", "ns") === 1000);
  check("printed as systemd prints them", formatTimespan(5400e6) === "1h 30min" && formatTimespan(100e3) === "100ms" && formatTimespan(0) === "0" && formatTimespan(Number.POSITIVE_INFINITY) === "infinity");
}

/* ------------------------------------------------------- systemd itself */

const POOLS: Readonly<Record<string, readonly string[]>> = {
  b: ["yes", "no", "1", "maybe", "", "Yes", "TRUE", '"yes"', "yes # on", "y", "nope"],
  t: ["5s", "5 min", "1h30min", "5Min", "5minutes", "", "infinity", "abc", "5 minuts", "-5s", "1.5h", "0", "10", "2 hours", "3x", "1.2.3", "30s # comment"],
  T: ["50ns", "1us", "", "5", "abc"],
  n: ["5", "-1", "", "0x10", "5k", "08", "010", "4294967296", "+3", "0b101", "1e3", "-0"],
  i: ["5", "-1", "", "0x10", "abc", "2147483648", "-0", "0o17"],
  N: ["-20", "19", "20", "", "abc", "+5", "-21", "0x5"],
  "%": ["50%", "50", "", "150%", "0.5%", "50.5%", "50.25%", "50.255%", "0%", "abc%", "5‰"],
  m: ["0022", "022", "999", "", "u=rwx", "0777", "7777", "17777", "0o22", "+22", "0x12"],
  z: ["1G", "1.5G", "1Gb", "512M", "50%", "infinity", "", "0", "abc", "1 G", "1GB", "1024", "1G 512M", "512M 1G", "150%", "0%", "10.5%", "1g", "5K"],
  Z: ["1M", "", "4K", "1MB", "abc", "infinity"],
  g: ["SIGTERM", "TERM", "15", "SIGFOO", "", "sigterm", "SIGRTMIN+3", "65", "0", "RTMIN", "SIGRTMAX-2", "SIGRTMIN+31", "KILL"],
  O: ["journal", "syslog", "file:/var/log/x", "file:relative", "append:/x", "", "bogus", "fd:foo", "null", "fd:", "fd:a:b", "truncate:/a/../b", "kmsg+console", "syslog+console", "file:%h/x", "file"],
  I: ["null", "tty", "file:/dev/null", "file:rel", "", "data", "bogus", "fd:x"],
  x: [
    "/bin/true", "bin/foo", "foo", "/usr/bin/", "-/bin/date +%F", "/bin/date +%F", '/bin/echo "unbalanced', '"/bin/echo', "", "!!/bin/true",
    "|echo hi > /tmp/x", "/bin/true ; /bin/false", "@/bin/true", "@/bin/true sleeper", "/bin/echo %%F %Y", '/bin/grep "\\d"', "+!/bin/true", "--/bin/true",
    "/bin/sh -c 'echo hi'", "-", "/bin/echo a \\; b", "/bin/echo ;", "; /bin/true", "/bin/echo 'a\\qb'", "./run.sh", "/bin/echo %i", "%h/bin/x", "/bin/echo $HOME",
    "-bin/foo", "/bin/echo \\x00", "/bin/echo \\101", ":/bin/true", "+/bin/true", "!/bin/true", "/bin/echo a;b", "/bin/./true", "/bin/../bin/true", '-/bin/echo "x',
    "/bin/echo \\u0041", '/bin/echo -n "\\s"', "/bin/true %", "/bin/echo 100%", "@", "-/bin/true ; bin/x", "/bin/true ; -bin/x ; /bin/false",
  ],
  u: ["network.target", "network", "foo.service bar", "foo@.service", "", "a.b", "%i.service", "%f.service", "foo.service", "multi-user", '"foo.service', "-.mount", "x@y.service", "foo.socket"],
  o: ["foo.service", "bar"],
  U: ["foo.service", "foo", "foo.timer", "", "%n", "foo.bar", "a.service", "foo.slice", "%Q.service"],
  e: ["FOO=1", "FOO=1 BAR", '"FOO=1 2"', '"FOO', "", "1A=b", "FOO", "FOO=a\\ b", "FOO=%Q", "FOO=\\d", "A=1 B=2", "PATH=/usr/bin:$PATH", "'X=y z'", "A=1 %Q=2 B=3"],
  f: ["/etc/default/x", "-/etc/x", "relative", "-relative", "", "/a/../b", "%h/x", "%Q"],
  w: ["/srv", "relative", "-relative", "~", "", "%h", "/a/../b", "-~", "%Q", "-%Q", "/srv/my dir", "-/a/../b"],
  p: ["/x", "relative", "", "%h/x", "/a/../b", "%Q"],
  F: ["/x", "relative", "", "%Q"],
  a: ["/x /y", "relative", "/x rel", "", "%h", "%Q /x"],
  P: ["/run/x.pid", "x.pid", "", "%Q"],
  d: ["https://example.com", "example.com", "man:foo(8)", "file:/x", "file:x", "", "http://", "https://a.com man:b(1)", "%Q", "man:"],
  q: ["/x", "!/x", "|/x", "relative", "", "|!relative", "| !/x", "%Q", "/a/../b"],
  Q: ["x86-64", "", "%Q"],
  k: ["root", "john doe", "1000", "65535", "a:b", "", "nobody", "%i", "-1", "..", "Admin", "my.user", "0", "01000", "%Q", "x$", "4294967295"],
  K: ["root wheel", "", "a:b", "1000 2000", "%Q"],
  c: ["daily", "Mon *-*-* 08:00", "bogus", "", "5min", "5x", "*:0/15", "%Q", "8:00"],
  r: ["1G", ""],
  s: ["hello", "", "50%", "%Q", "100%%", "a %H b", "%"],
  l: ["1024", "65536", "infinity", "", "1024:4096", "4096:1024", "1K", "64M", "1h", "-5", "+5", "-21", "+20", "40", "41", "abc", "1:2:3", "1024:", ":1024", "0x10", "infinity:1024", "1024:infinity", "500ms", "30"],
  D: ["foo", "/var/lib/foo", "private", "private/x", "foo/../x", "", "a:b", "a::ro", "a:b:rw", "a b", "%n", "%Q", "/run/foo", "foo:/abs", "privates", "./foo", "a/b"],
  R: ["/x", "-/x", "+/x", "-+/x", "+-/x", "rel", "", "/a/../b", "%h", "%Q /x", "/x rel", '"/a b"'],
  X: ["", "infinity", "100", "0", "50%", "150%", "abc", "-1", "0%", "18446744073709551615"],
  W: ["", "100", "0", "1", "10000", "10001", "idle", "abc", "-5"],
  C: ["CAP_NET_ADMIN", "cap_net_admin", "CAP_NET_BIND", "~CAP_SYS_ADMIN", "12", "63", "", "CAP_FOO CAP_KILL", "NET_ADMIN"],
  E: ["", "bogus", "Simple", "yes", "none", "7", "128", "3", "4", "kern", "on-failure", "mixed", "private", "strict", "self", "full", "private:myhost", "no:host", "yes:bad_host", "y"],
};

interface UnitCase {
  readonly label: string;
  /** The files, the first being the one systemd-analyze verify is pointed at. */
  readonly files: readonly { readonly path: string; readonly text: string }[];
  /** What the analyzer is given: the first file alone, or every file as systemctl cat prints them. */
  readonly paste: "first" | "cat";
}

interface VerifyAnswer {
  /** Line in the paste → systemd's messages about it. */
  readonly lines: Map<number, string[]>;
  /** Lines with a message at warning level or above. */
  readonly loud: Set<number>;
  readonly unit: string[];
  refused: boolean;
  raw: string;
}

const encode = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/** Settings that name other units or mounts: only these need verify to load other units. */
const DEPENDENCY_KEYS = new Set(
  ["Unit", "Service", "Timer"].flatMap((section) => directivesOf(section).filter((info) => "uoUa".includes(info.kind)).map((info) => info.name)),
);

/**
 * `--recursive-errors=no` makes verify about nine times faster, but it also
 * skips adding dependencies, and with them systemd's warnings about bad
 * names in After= and the like. Cases with such settings run in full.
 */
function needsDependencies(unitCase: UnitCase): boolean {
  return unitCase.files.some((file) => file.text.split("\n").some((line) => DEPENDENCY_KEYS.has(/^\s*([A-Za-z]+)\s*=/.exec(line)?.[1] ?? "")));
}

/** The paste, and where each file's line 1 lands in it. */
export function pasteOf(unitCase: UnitCase): { text: string; offsets: Map<string, number>; name: string | null } {
  const offsets = new Map<string, number>();
  if (unitCase.paste === "first") {
    offsets.set(unitCase.files[0]!.path, 0);
    return { text: unitCase.files[0]!.text, offsets, name: unitCase.files[0]!.path };
  }
  const lines: string[] = [];
  for (const file of unitCase.files) {
    if (lines.length > 0) lines.push("");
    lines.push(`# /etc/systemd/system/${file.path}`);
    offsets.set(file.path, lines.length);
    lines.push(...file.text.replace(/\n$/, "").split("\n"));
  }
  return { text: `${lines.join("\n")}\n`, offsets, name: null };
}

export function askVerify(shell: (script: string) => string, cases: readonly UnitCase[]): VerifyAnswer[] {
  const script = ["root=$(mktemp -d)"];
  cases.forEach((unitCase, i) => {
    script.push(`d=$root/${i}; mkdir -p $d; cd $d`);
    for (const file of unitCase.files) {
      if (file.path.includes("/")) script.push(`mkdir -p ${file.path.slice(0, file.path.lastIndexOf("/"))}`);
      script.push(`printf '%s' '${encode(file.text)}' | base64 -d > ${file.path}; chmod 644 ${file.path}`);
    }
    const main = unitCase.files[0]!.path;
    const verify = `systemd-analyze verify --man=no --generators=no${needsDependencies(unitCase) ? "" : " --recursive-errors=no"} ./${main} 2>&1`;
    script.push(`echo "@@@ ${i} W"; SYSTEMD_LOG_LEVEL=warning ${verify}`);
    script.push(`echo "@@@ ${i} A"; ${verify}`);
  });
  script.push("cd /; rm -rf $root");
  const output = shell(`${script.join("\n")}\n`);
  const answers: VerifyAnswer[] = cases.map(() => ({ lines: new Map(), loud: new Set(), unit: [], refused: false, raw: "" }));
  const blocks = output.split(/^@@@ (\d+) ([WA])$/m);
  for (let k = 1; k < blocks.length; k += 3) {
    const index = Number(blocks[k]);
    const run = blocks[k + 1];
    const body = blocks[k + 2] ?? "";
    const unitCase = cases[index]!;
    const answer = answers[index]!;
    const { offsets } = pasteOf(unitCase);
    const main = unitCase.files[0]!.path;
    if (run === "A") answer.raw = body.trim();
    for (const line of body.split("\n")) {
      // Not about the file: programs missing on this machine, units it does not have, verify's own job logs.
      if (line.trim() === "" || /is not executable|is marked|Proceeding anyway|Failed to create \S+\/start: Unit \S+ not found|[Jj]ob\b/.test(line)) continue;
      const at = /\/([^/\s]+(?:\.d\/[^/\s]+)?):(\d+): (.*)$/.exec(line);
      const file = at ? [...offsets.keys()].find((path) => line.includes(`/${path}:${at[2]}:`)) : undefined;
      if (at && file !== undefined) {
        const n = offsets.get(file)! + Number(at[2]);
        if (run === "W") answer.loud.add(n);
        else answer.lines.set(n, [...(answer.lines.get(n) ?? []), at[3]!]);
        continue;
      }
      if (run !== "A") continue;
      if (line.startsWith(`Unit ${main} has a bad unit file setting`) || line.startsWith(`Unit ${main} failed to load properly`)) answer.refused = true;
      else if (line.startsWith(`${main}: `) && !/Unit configuration has fatal error/.test(line)) answer.unit.push(line.slice(main.length + 2));
    }
  }
  return answers;
}

/** Where the analyzer and systemd part ways on one case, or "". */
export function disagreement(unitCase: UnitCase, answer: VerifyAnswer): string {
  const { text, name } = pasteOf(unitCase);
  const analysis: UnitAnalysis = analyzeUnits(text, name);
  const ours = new Map<number, Finding[]>();
  for (const f of analysis.findings) if (f.source === "line") ours.set(f.systemdLine!, [...(ours.get(f.systemdLine!) ?? []), f]);
  for (const n of [...new Set([...answer.lines.keys(), ...ours.keys()])].sort((a, b) => a - b)) {
    const theirs = answer.lines.get(n);
    const mine = ours.get(n);
    if (!theirs) return `line ${n}: systemd says nothing, here “${mine![0]!.text.en}”`;
    if (!mine) return `line ${n}: systemd says “${theirs.join(" | ")}”, here nothing`;
    const loud = mine.some((f) => f.level === "error" || f.level === "warning");
    if (loud !== answer.loud.has(n)) return `line ${n}: systemd logs “${theirs.join(" | ")}” at ${answer.loud.has(n) ? "warning or above" : "notice or below"}, here ${mine.map((f) => f.level).join(", ")}`;
  }
  const main = unitCase.files[0]!.path.replace(/^.*\//, "");
  const unit = analysis.units.find((u) => u.name === main) ?? analysis.units[0];
  if ((unit?.refused ?? false) !== answer.refused) return `systemd ${answer.refused ? "refuses" : "loads"} the unit, here it ${unit?.refused ? "is refused" : "loads"}`;
  const unitFindings = analysis.findings.filter((f) => f.source === "unit");
  if (unitFindings.length !== answer.unit.length) return `about the unit, systemd says [${answer.unit.join(" | ")}], here [${unitFindings.map((f) => f.text.en).join(" | ")}]`;
  return "";
}

function compareVerify(check: Check, label: string, cases: readonly UnitCase[], answers: readonly VerifyAnswer[]): void {
  let first = "";
  let agreed = 0;
  let lines = 0;
  let refused = 0;
  cases.forEach((unitCase, i) => {
    const answer = answers[i]!;
    lines += answer.lines.size;
    if (answer.refused) refused += 1;
    const problem = disagreement(unitCase, answer);
    if (problem === "") agreed += 1;
    else if (first === "") first = `${unitCase.label}: ${problem}`;
  });
  console.log(`     ${cases.length} ${label}: systemd complained about ${lines} lines and refused ${refused} units`);
  check(`systemd and the analyzer agree on all ${cases.length} ${label}`, agreed === cases.length, `${cases.length - agreed} differ; first: ${first}`);
}

export function directiveCases(): UnitCase[] {
  const cases: UnitCase[] = [];
  let oneshot = false;
  for (const section of ["Unit", "Service", "Install"]) {
    for (const info of directivesOf(section)) {
      for (const value of POOLS[info.kind] ?? []) {
        oneshot = !oneshot;
        const line = `${info.name}=${value}`;
        const unit = section === "Unit" ? `Description=probe\n${line}\n` : "Description=probe\n";
        const service = `${oneshot ? "Type=oneshot\n" : ""}ExecStart=/bin/true\n${section === "Service" ? `${line}\n` : ""}`;
        const install = section === "Install" ? `[Install]\n${line}\n` : "";
        cases.push({ label: `[${section}] ${line}`, files: [{ path: "a.service", text: `[Unit]\n${unit}[Service]\n${service}${install}` }], paste: "first" });
      }
    }
  }
  for (const info of directivesOf("Timer")) {
    for (const value of POOLS[info.kind] ?? []) {
      cases.push({
        label: `[Timer] ${info.name}=${value}`,
        files: [
          { path: "a.timer", text: `[Unit]\nDescription=probe\n[Timer]\nOnCalendar=daily\n${info.name}=${value}\n[Install]\nWantedBy=timers.target\n` },
          { path: "a.service", text: "[Service]\nExecStart=/bin/true\n" },
        ],
        paste: "first",
      });
    }
  }
  return cases;
}

const COMMON: Readonly<Record<string, readonly string[]>> = {
  Unit: ["Description", "After", "Wants", "Requires", "Documentation", "ConditionPathExists", "StartLimitIntervalSec", "StartLimitBurst", "OnFailure", "Before", "PartOf"],
  Service: [
    "Type", "ExecStart", "ExecStartPre", "ExecStop", "ExecReload", "Restart", "RestartSec", "User", "Group", "WorkingDirectory", "Environment", "EnvironmentFile",
    "TimeoutStartSec", "RemainAfterExit", "StandardOutput", "StandardError", "KillMode", "Nice", "MemoryMax", "CPUQuota", "LimitNOFILE", "PIDFile", "BusName",
    "RuntimeMaxSec", "SuccessAction", "DynamicUser", "ProtectSystem", "PrivateTmp", "UMask", "KillSignal", "SyslogIdentifier", "RestartSteps", "RestartMaxDelaySec",
    "ExitType", "PrivatePIDs", "StateDirectory", "ReadWritePaths", "CapabilityBoundingSet", "TasksMax", "CPUWeight",
  ],
  Timer: ["OnCalendar", "OnBootSec", "OnUnitActiveSec", "OnActiveSec", "Persistent", "Unit", "AccuracySec", "RandomizedDelaySec", "OnClockChange"],
  Install: ["WantedBy", "RequiredBy", "Alias", "Also"],
};

/** Whole files with mistakes mixed in: wrong case, stray lines, continuations, comments, broken headers. */
function randomFile(rng: () => number, kind: "service" | "timer" | "dropin"): string {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rng() * list.length)]!;
  const usual: Readonly<Record<string, readonly string[]>> = {
    Type: ["simple", "oneshot", "forking", "notify", "dbus", "exec"],
    Restart: ["always", "on-failure", "no", "on-success"],
    ExitType: ["main", "cgroup"],
    SuccessAction: ["none", "exit", "reboot"],
  };
  const line = (section: string): string => {
    const key = pick(COMMON[section]!);
    const info = directivesOf(section).find((d) => d.name === key);
    const pool = info ? (POOLS[info.kind] ?? ["x"]) : ["x"];
    let value = pick(usual[key] && rng() < 0.7 ? usual[key]! : pool.length > 0 ? pool : ["x"]);
    const r = rng();
    const name = r < 0.05 ? key.toLowerCase() : r < 0.08 ? `${key}s` : r < 0.1 ? `X-${key}` : key;
    if (rng() < 0.04) value = `${value} \\`;
    return rng() < 0.05 ? `${name} = ${value}` : `${name}=${value}`;
  };
  const sections = kind === "timer" ? ["Unit", "Timer", "Install"] : kind === "dropin" ? ["Service"] : ["Unit", "Service", "Install"];
  const lines: string[] = [];
  for (const section of sections) {
    if (section === "Install" && rng() < 0.4) continue;
    lines.push(rng() < 0.03 ? `[${section.toLowerCase()}]` : rng() < 0.02 ? `[${section}` : `[${section}]`);
    const count = 1 + Math.floor(rng() * (section === "Service" ? 6 : 3));
    for (let k = 0; k < count; k += 1) {
      if (rng() < 0.08) lines.push(pick(["# comment", "; comment", "", "   ", "  # indented \\"]));
      lines.push(line(section));
    }
    if (kind === "dropin" && rng() < 0.5) lines.push(rng() < 0.5 ? "ExecStart=" : "ExecStart=/bin/false");
    if (kind === "service" && rng() < 0.7) lines.push(rng() < 0.8 ? "ExecStart=/bin/true" : "ExecStart=bin/true");
    if (section === "Timer" && rng() < 0.6) lines.push("OnCalendar=daily");
  }
  if (kind !== "dropin" && rng() < 0.05) lines.unshift("Description=stray");
  return `${lines.join("\n")}\n`;
}

export function generatedCases(seed: number, count: number): UnitCase[] {
  const rng = seeded(seed);
  return Array.from({ length: count }, (_, n): UnitCase => {
    const timer = rng() < 0.3;
    return timer
      ? { label: `generated timer #${n}`, files: [{ path: "a.timer", text: randomFile(rng, "timer") }, { path: "a.service", text: "[Service]\nExecStart=/bin/true\n" }], paste: "first" }
      : { label: `generated service #${n}`, files: [{ path: "a.service", text: randomFile(rng, "service") }], paste: "first" };
  });
}

export function dropInCases(seed: number, count: number): UnitCase[] {
  const rng = seeded(seed);
  return Array.from({ length: count }, (_, n): UnitCase => {
    const files = [{ path: "a.service", text: rng() < 0.7 ? "[Unit]\nDescription=probe\n[Service]\nExecStart=/bin/true\n" : randomFile(rng, "service") }];
    const extra = 1 + Math.floor(rng() * 2);
    for (let k = 0; k < extra; k += 1) files.push({ path: `a.service.d/${10 + k}-override.conf`, text: randomFile(rng, "dropin") });
    return { label: `drop-ins #${n}`, files, paste: "cat" };
  });
}

function liveTimespans(check: Check, shell: (script: string) => string): void {
  console.log("\n-- time spans: systemd-analyze timespan, on generated text --");
  const rng = seeded(4242);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rng() * list.length)]!;
  const units = ["", "s", "sec", "seconds", "m", "min", "minutes", "minuts", "h", "hr", "hours", "d", "days", "w", "weeks", "M", "months", "y", "years", "ms", "msec", "us", "µs", "Min", "H", "x", "secs"];
  const texts = Array.from({ length: 400 }, () => {
    const terms = 1 + Math.floor(rng() * 3);
    let text = "";
    for (let t = 0; t < terms; t += 1) {
      const number = rng() < 0.15 ? `${Math.floor(rng() * 100)}.${Math.floor(rng() * 100)}` : rng() < 0.05 ? "-3" : String(Math.floor(rng() * 1000));
      text += `${t > 0 && rng() < 0.7 ? " " : ""}${number}${rng() < 0.3 ? " " : ""}${pick(units)}`;
    }
    return rng() < 0.03 ? "infinity" : text;
  });
  const script = texts.map((text, i) => `echo '@@@ ${i}'; systemd-analyze timespan -- '${text.replace(/'/g, `'\\''`)}' 2>&1`).join("\n");
  const output = shell(`${script}\n`);
  const blocks = output.split(/^@@@ (\d+)$/m);
  let differ = "";
  let valid = 0;
  for (let k = 1; k < blocks.length; k += 2) {
    const text = texts[Number(blocks[k])]!;
    const body = blocks[k + 1] ?? "";
    const us = /μs: (\d+)/.exec(body)?.[1];
    const human = /Human: (.*)$/m.exec(body)?.[1]?.trim();
    const theirs = us === undefined ? null : us === "18446744073709551615" ? "infinity" : BigInt(us);
    const ours = parseTimespanExact(text);
    if (theirs !== null) valid += 1;
    if (theirs !== ours && differ === "") differ = `${JSON.stringify(text)}: systemd ${theirs ?? "refuses"}, here ${ours ?? "refused"}`;
    else if (theirs !== null && human !== formatTimespan(theirs === "infinity" ? Number.POSITIVE_INFINITY : theirs) && differ === "") {
      differ = `${JSON.stringify(text)} prints as ${human}, here ${formatTimespan(theirs === "infinity" ? Number.POSITIVE_INFINITY : theirs)}`;
    }
  }
  console.log(`     ${texts.length} time spans, ${valid} of them valid`);
  check("systemd and the analyzer read every time span alike, and print them alike", differ === "", differ);
}

export async function runUnitChecks(check: Check): Promise<void> {
  pinnedChecks(check);
  timespanChecks(check);

  const shell = findSystemd();
  if (shell === null) {
    console.log("\n  note: systemd-analyze is not reachable — the live unit file checks were skipped.");
    return;
  }
  liveTimespans(check, shell);

  console.log("\n-- unit files: systemd-analyze verify on every directive, with good and bad values --");
  {
    const cases = directiveCases();
    compareVerify(check, "one-line probes", cases, askVerify(shell, cases));
  }
  console.log("\n-- unit files: systemd-analyze verify on generated whole files --");
  {
    const cases = generatedCases(7, 250);
    compareVerify(check, "generated files", cases, askVerify(shell, cases));
  }
  console.log("\n-- unit files: drop-ins, pasted as systemctl cat prints them --");
  {
    const cases = dropInCases(99, 120);
    compareVerify(check, "units with drop-ins", cases, askVerify(shell, cases));
  }
}
