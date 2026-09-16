/** Wiring for the IoPanel component: input in, transformed text out. */

import type { FormatResult } from "./format";
import { attachCopy, downloadText, el } from "./ui";

export interface TextIoOptions {
  /** May be async — YAML loads its parser on first use. */
  transform: (input: string) => FormatResult | Promise<FormatResult>;
  /** Filename for the Save button. */
  downloadName: string;
  /** Loaded by the Sample button; the button stays hidden when omitted. */
  sample?: string;
}

export interface TextIo {
  /** Re-runs the transform. Call this when an option outside the textarea changes. */
  run: () => void;
  input: HTMLTextAreaElement;
}

const DEBOUNCE_MS = 140;

function describe(text: string): string {
  if (text.length === 0) return "";
  const lines = text.split("\n").length;
  const bytes = new TextEncoder().encode(text).length;
  const chars = `${text.length.toLocaleString("en-US")} char${text.length === 1 ? "" : "s"}`;
  // Bytes are only worth showing when they disagree with the character count,
  // which is exactly when someone needs to know (non-ASCII input).
  const size = bytes === text.length ? chars : `${chars}, ${bytes.toLocaleString("en-US")} bytes`;
  return `${size} · ${lines.toLocaleString("en-US")} line${lines === 1 ? "" : "s"}`;
}

export function attachTextIo(options: TextIoOptions): TextIo {
  const input = el<HTMLTextAreaElement>("#io-input");
  const output = el<HTMLTextAreaElement>("#io-output");
  const errorBox = el<HTMLParagraphElement>("#io-error");
  const inputMeta = el<HTMLElement>("#input-meta");
  const outputMeta = el<HTMLElement>("#output-meta");

  let timer: number | undefined;
  // Async transforms can land out of order once the parser import resolves.
  // Only the newest run is allowed to write to the DOM.
  let generation = 0;

  const render = (result: FormatResult): void => {
    if (result.ok) {
      output.value = result.output;
      errorBox.hidden = true;
      outputMeta.textContent = result.note
        ? `${describe(result.output)} · ${result.note}`
        : describe(result.output);
    } else {
      output.value = "";
      errorBox.textContent = result.message;
      errorBox.hidden = false;
      outputMeta.textContent = "";
    }
  };

  const run = (): void => {
    inputMeta.textContent = describe(input.value);

    if (input.value.length === 0) {
      render({ ok: true, output: "" });
      return;
    }

    const mine = ++generation;
    let result: FormatResult | Promise<FormatResult>;
    try {
      result = options.transform(input.value);
    } catch (error) {
      render({ ok: false, message: error instanceof Error ? error.message : String(error) });
      return;
    }

    if (result instanceof Promise) {
      result
        .then((value) => {
          if (mine === generation) render(value);
        })
        .catch((error: unknown) => {
          if (mine === generation) {
            render({ ok: false, message: error instanceof Error ? error.message : String(error) });
          }
        });
    } else {
      render(result);
    }
  };

  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(run, DEBOUNCE_MS);
  });

  el<HTMLButtonElement>("#io-clear").addEventListener("click", () => {
    input.value = "";
    input.focus();
    run();
  });

  attachCopy(el<HTMLButtonElement>("#io-copy"), () => output.value);

  el<HTMLButtonElement>("#io-download").addEventListener("click", () => {
    if (output.value.length > 0) downloadText(options.downloadName, output.value);
  });

  const swap = document.getElementById("io-swap");
  if (swap) {
    swap.addEventListener("click", () => {
      if (output.value.length === 0) return;
      input.value = output.value;
      run();
    });
  }

  const sampleButton = document.getElementById("io-sample");
  if (sampleButton && options.sample !== undefined) {
    sampleButton.hidden = false;
    sampleButton.addEventListener("click", () => {
      input.value = options.sample!;
      run();
    });
  }

  run();
  return { run, input };
}
