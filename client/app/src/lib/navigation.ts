const LAST_ROUTE_KEY = "delivery-mobile.last-route.v1";

export function saveLastRoute(pathname: string) {
  if (typeof window === "undefined" || !pathname.startsWith("/")) return;
  window.sessionStorage.setItem(LAST_ROUTE_KEY, pathname);
}

export function getLastRoute() {
  if (typeof window === "undefined") return "";
  const pathname = window.sessionStorage.getItem(LAST_ROUTE_KEY) ?? "";
  return pathname.startsWith("/") && !pathname.startsWith("/login") ? pathname : "";
}
