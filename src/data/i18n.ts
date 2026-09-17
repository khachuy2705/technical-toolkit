/**
 * Strings for the shared page chrome — header, footer, tool layout, theme
 * toggle. The site is English; a page opts into another language by passing
 * `lang` to its layout, and everything the layout draws follows.
 *
 * Page content is not here: each page writes its own. Tool names live in the
 * registry, next to the English ones they translate.
 */

export type Lang = "en" | "vi";

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
    privacyBadge: "Generated locally with your browser’s crypto API. Nothing is sent anywhere.",
    moreTools: "More tools",
    planned: "Planned",
    themePrefix: "Colour theme",
    themeHint: "Click to change.",
    themeNames: { light: "light", dark: "dark", system: "system" },
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
  },
};
