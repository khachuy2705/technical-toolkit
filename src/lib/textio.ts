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
  /**
   * Syntax colouring for both panes. Needs `<IoPanel highlight>`, which puts a
   * `<pre>` layer behind each textarea.
   */
  highlight?: {
    /** HTML for a layer. `errorAt` is -1, or the offset to mark in the input. */
    render: (text: string, errorAt: number) => string;
    /** Where a failed input broke, for the mark. Called only after a failure. */
    locate?: (text: string) => number;
    /** Above this many characters a pane is shown as plain text. */
    limit: number;
  };
}

export interface TextIo {
  /** Re-runs the transform. Call this when an option outside the textarea changes. */
  run: () => void;
  input: HTMLTextAreaElement;
}

const DEBOUNCE_MS = 140;

/**
 * One textarea with its colour layer. The textarea's own text is transparent
 * and the layer underneath shows the same characters in colour, so typing,
 * selection, copying and resizing all stay native.
 */
interface Layered {
  paint: (text: string, errorAt?: number) => void;
}

function layer(textarea: HTMLTextAreaElement, options: TextIoOptions): Layered | null {
  const pre = document.getElementById(`${textarea.id}-layer`);
  const highlight = options.highlight;
  if (!pre || !highlight) return null;
  const wrapper = pre.parentElement!;

  const follow = () => {
    pre.scrollTop = textarea.scrollTop;
    pre.scrollLeft = textarea.scrollLeft;
  };
  textarea.addEventListener("scroll", follow);

  return {
    paint(text, errorAt = -1) {
      if (text.length > highlight.limit) {
        // The textarea shows its own text again; no half-coloured document.
        wrapper.dataset["plain"] = "";
        pre.textContent = "";
        return;
      }
      delete wrapper.dataset["plain"];
      pre.innerHTML = highlight.render(text, errorAt);
      follow();
    },
  };
}

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

  const inputLayer = layer(input, options);
  const outputLayer = layer(output, options);

  let timer: number | undefined;
  // Async transforms can land out of order once the parser import resolves.
  // Only the newest run is allowed to write to the DOM.
  let generation = 0;

  const render = (result: FormatResult): void => {
    outputLayer?.paint(result.ok ? result.output : "");
    if (inputLayer && !result.ok && options.highlight?.locate && input.value.length <= options.highlight.limit) {
      inputLayer.paint(input.value, options.highlight.locate(input.value));
    }
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
    inputLayer?.paint(input.value);

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
    // The textarea's text is transparent, so its layer has to follow every
    // keystroke at once; only the transform itself waits for a pause.
    inputLayer?.paint(input.value);
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
