/** Small DOM helpers shared by the tool pages. No framework, no global state. */

import { copyText } from "./clipboard";
import { classifyStrength, crackTime } from "./entropy";

/** Query one element, loudly. A missing hook is a bug in the page, not a runtime condition. */
export function el<T extends Element>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}

export function all<T extends Element>(selector: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

/** Announces transient status to screen readers, which never see the button flash. */
function announce(message: string): void {
  let region = document.getElementById("live-region");
  if (!region) {
    region = document.createElement("div");
    region.id = "live-region";
    region.className = "visually-hidden";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.appendChild(region);
  }
  region.textContent = message;
}

const COPY_FEEDBACK_MS = 1400;

/**
 * Wires a button to copy text. The label inside `[data-label]` (or the button
 * itself) briefly becomes "Copied", and reverts even if the user clicks again
 * mid-flash.
 */
export function attachCopy(button: HTMLButtonElement, getText: () => string): void {
  const labelEl = button.querySelector<HTMLElement>("[data-label]");
  const original = labelEl?.textContent ?? "";
  let timer: number | undefined;

  button.addEventListener("click", async () => {
    const text = getText();
    if (!text) return;

    const ok = await copyText(text);
    window.clearTimeout(timer);

    button.dataset["copied"] = String(ok);
    if (labelEl) labelEl.textContent = ok ? "Copied" : "Copy failed";
    announce(ok ? "Copied to clipboard" : "Copy failed");

    timer = window.setTimeout(() => {
      delete button.dataset["copied"];
      if (labelEl) labelEl.textContent = original;
    }, COPY_FEEDBACK_MS);
  });
}

/** Offers `text` as a .txt download. */
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Paints the five-segment meter and the entropy readout beneath it. */
export function renderStrength(root: HTMLElement, bits: number): void {
  const { level, label } = classifyStrength(bits);
  root.dataset["level"] = String(level);
  el("[data-strength-label]", root).textContent = label;
  el("[data-strength-bits]", root).textContent = bits.toFixed(1);
  el("[data-strength-time]", root).textContent = crackTime(bits);
}

/** Keeps a range input and its numeric read-out in sync. */
export function bindRange(
  input: HTMLInputElement,
  output: HTMLElement,
  onChange: () => void,
): void {
  const sync = () => {
    output.textContent = input.value;
    onChange();
  };
  input.addEventListener("input", sync);
  output.textContent = input.value;
}

/** Clamps a number input to its own min/max, falling back to `fallback` on junk. */
export function readNumber(input: HTMLInputElement, fallback: number): number {
  const parsed = Number.parseInt(input.value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  const min = Number.parseInt(input.min, 10);
  const max = Number.parseInt(input.max, 10);
  return Math.min(Number.isFinite(max) ? max : parsed, Math.max(Number.isFinite(min) ? min : parsed, parsed));
}

/**
 * Wires the bulk panel: count input, generate, copy-all, download and one copy
 * button per row. Both tool pages use it; they differ only in `generate` and
 * the download filename.
 */
export function attachBulk(options: {
  generate: (count: number) => string[];
  filename: string;
  copyIcon: string;
}): void {
  const countInput = el<HTMLInputElement>("#bulk-count");
  const list = el<HTMLUListElement>("#bulk-list");
  const empty = el<HTMLParagraphElement>("#bulk-empty");
  let items: string[] = [];

  const render = () => {
    list.replaceChildren(
      ...items.map((value) => {
        const row = document.createElement("li");
        row.className = "bulk__item";

        const text = document.createElement("span");
        text.textContent = value;

        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn--icon";
        button.title = "Copy";
        button.setAttribute("aria-label", "Copy this line");
        button.innerHTML = options.copyIcon;
        attachCopy(button, () => value);

        row.append(text, button);
        return row;
      }),
    );
    empty.hidden = items.length > 0;
  };

  el<HTMLButtonElement>("#bulk-generate").addEventListener("click", () => {
    try {
      items = options.generate(readNumber(countInput, 10));
    } catch {
      items = []; // The single-result panel already shows why the options are invalid.
    }
    render();
  });

  attachCopy(el<HTMLButtonElement>("#bulk-copy"), () => items.join("\n"));

  el<HTMLButtonElement>("#bulk-download").addEventListener("click", () => {
    if (items.length > 0) downloadText(options.filename, items.join("\n") + "\n");
  });

  render();
}

/**
 * Per-viewer settings, stored in localStorage.
 *
 * Purely a convenience: storage can be unavailable or hold stale junk from an
 * older version of the page, so every failure silently falls back to defaults.
 */
export function loadPrefs<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return fallback;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

export function savePrefs(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or a private window — the page works fine without persistence.
  }
}
