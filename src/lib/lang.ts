/**
 * The language switch of a bilingual page (lang="both"). The inline script in
 * BaseLayout picks the language before first paint; this lets the reader
 * change it. Text follows by CSS alone; attributes, the title and anything a
 * page script draws are updated here and through `onLangChange`.
 *
 * DOM-only, like ui.ts, and imported by no verification script.
 */

import type { Lang } from "../data/i18n";

const STORAGE_KEY = "tt-lang";
const EVENT = "tt:lang";

/** Attributes a bilingual element carries in both languages, as data-en-* and data-vi-*. */
const ATTRIBUTES = ["placeholder", "aria-label", "title"] as const;

export function pageLang(): Lang {
  return document.documentElement.dataset["lang"] === "vi" ? "vi" : "en";
}

/** Shows the page in `lang`. Only a choice the reader made is remembered. */
export function setPageLang(lang: Lang, remember: boolean): void {
  const root = document.documentElement;
  root.dataset["lang"] = lang;
  root.lang = lang;
  const title = root.getAttribute(`data-title-${lang}`);
  if (title) document.title = title;
  for (const name of ATTRIBUTES) {
    for (const node of document.querySelectorAll<HTMLElement>(`[data-${lang}-${name}]`)) {
      node.setAttribute(name, node.getAttribute(`data-${lang}-${name}`) ?? "");
    }
  }
  if (remember) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // A private window: the switch still works for this page view.
    }
  }
  document.dispatchEvent(new CustomEvent<Lang>(EVENT, { detail: lang }));
}

export function onLangChange(callback: (lang: Lang) => void): void {
  document.addEventListener(EVENT, (event) => callback((event as CustomEvent<Lang>).detail));
}

/** Wires the radios of LangSwitch.astro. */
export function bindLangSwitch(): void {
  const radios = [...document.querySelectorAll<HTMLInputElement>('input[name="page-lang"]')];
  for (const radio of radios) radio.checked = radio.value === pageLang();
  // The inline script set the text; a page that opened in Vietnamese still needs its attributes.
  if (pageLang() !== "en") setPageLang(pageLang(), false);
  for (const radio of radios) {
    radio.addEventListener("change", () => {
      if (radio.checked) setPageLang(radio.value === "vi" ? "vi" : "en", true);
    });
  }
}
