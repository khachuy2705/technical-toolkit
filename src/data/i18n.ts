/**
 * Strings for the shared page chrome — header, footer, tool layout, theme
 * toggle. The site is English; a page opts into another language by passing
 * `lang` to its layout, and everything the layout draws follows. A page passed
 * `both` draws every string twice and lets the reader pick.
 *
 * Page content is not here: each page writes its own. Tool names live in the
 * registry, next to the English ones they translate.
 */

export type Lang = "en" | "vi";

/**
 * The language a page is rendered in. `both` carries every string in English
 * and Vietnamese and lets the reader switch on the page; see LangSwitch.astro.
 */
export type PageLang = Lang | "both";

/** The same words in both languages, for output a bilingual page shows in either. */
export interface Both {
  readonly en: string;
  readonly vi: string;
}

/**
 * An attribute that follows a bilingual page's language. Spread onto an
 * element: the English value is the initial one, and `lib/lang.ts` swaps in
 * the other when the reader switches.
 */
export function bothAttr(name: string, en: string, vi: string): Record<string, string> {
  return { [name]: en, [`data-en-${name}`]: en, [`data-vi-${name}`]: vi };
}

/** An attribute in the page's language, or in both for a bilingual page. */
export function langAttr(lang: PageLang, name: string, en: string, vi: string): Record<string, string> {
  if (lang === "both") return bothAttr(name, en, vi);
  return { [name]: lang === "vi" ? vi : en };
}

export interface ChromeText {
  /** BCP 47 tag for `<html lang>`, which also drives screen-reader pronunciation. */
  htmlLang: string;
  mainNav: string;
  about: string;
  privacy: string;
  footerNote: string;
  breadcrumb: string;
  breadcrumbHome: string;
  privacyBadge: string;
  moreTools: string;
  planned: string;
  themePrefix: string;
  themeHint: string;
  themeNames: { light: string; dark: string; system: string };
  /** Label of the language switch on a bilingual page. */
  language: string;
}

export const CHROME: Record<Lang, ChromeText> = {
  en: {
    htmlLang: "en",
    mainNav: "Main",
    about: "About",
    privacy: "Privacy",
    footerNote: "Everything runs in your browser. No data leaves this page.",
    breadcrumb: "Breadcrumb",
    breadcrumbHome: "Tools",
    privacyBadge: "Runs entirely in your browser. Nothing you enter is sent anywhere.",
    moreTools: "More tools",
    planned: "Planned",
    themePrefix: "Colour theme",
    themeHint: "Click to change.",
    themeNames: { light: "light", dark: "dark", system: "system" },
    language: "Language",
  },
  vi: {
    htmlLang: "vi",
    mainNav: "Điều hướng chính",
    about: "Giới thiệu",
    privacy: "Quyền riêng tư",
    footerNote: "Mọi thứ chạy trong trình duyệt của bạn. Không dữ liệu nào rời khỏi trang này.",
    breadcrumb: "Vị trí trang",
    breadcrumbHome: "Công cụ",
    privacyBadge: "Tính toán ngay trên trình duyệt của bạn. Không có dữ liệu nào được gửi đi.",
    moreTools: "Công cụ khác",
    planned: "Sắp có",
    themePrefix: "Giao diện",
    themeHint: "Bấm để đổi.",
    themeNames: { light: "sáng", dark: "tối", system: "theo hệ thống" },
    language: "Ngôn ngữ",
  },
};
