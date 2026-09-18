// Code-only preloads: importing a page never authenticates, signs or submits.
export const pageLoaders = {
  markets: () => import("./pages/Markets.js"),
  market: () => import("./pages/MarketDetail.js"),
  assets: () => import("./pages/Assets.js"),
  entitlements: () => import("./pages/Entitlements.js"),
  history: () => import("./pages/History.js"),
  help: () => import("./pages/Help.js"),
  creator: () => import("./pages/Creator.js"),
  reports: () => import("./pages/Reports.js"),
};
export function routePage(pathname: string): keyof typeof pageLoaders | null {
  const [, environment, page, detail] = pathname.split("/");
  if (!environment) return "markets";
  if (!page || page === "markets") return detail ? "market" : "markets";
  if (page === "creator") return "creator";
  if (["leaderboard", "ops", "feedback"].includes(page)) return "reports";
  return ["assets", "entitlements", "history", "help"].includes(page)
    ? (page as "assets" | "entitlements" | "history" | "help")
    : null;
}
export function preloadPage(pathname: string) {
  const page = routePage(pathname);
  if (page) void pageLoaders[page]().catch(() => undefined);
}
