export function canonicalizeUrl(raw: string): string {
  const url = new URL(raw);

  // Remove fragment
  url.hash = "";

  // Remove utm_* and other tracking params
  const trackingPrefixes = ["utm_", "fbclid", "gclid", "ref", "mc_"];
  const keysToDelete: string[] = [];
  url.searchParams.forEach((_, key) => {
    if (trackingPrefixes.some((p) => key.startsWith(p))) {
      keysToDelete.push(key);
    }
  });
  keysToDelete.forEach((k) => url.searchParams.delete(k));

  // Normalize trailing slash: remove it unless path is just "/"
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}
