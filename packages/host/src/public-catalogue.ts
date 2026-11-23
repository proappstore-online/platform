/** Approved, healthy public discovery output; not the raw apps/provisioning table. */
export interface CatalogueApp {
  id: string;
  name: string;
  description: string;
  appUrl: string;
}
// Only plain data is shared across requests. An in-flight promise must not be:
// Workers drop its settlement in any request other than the one that created
// it, so a second awaiter throws once the first request ends (#616).
let cache: { apps: CatalogueApp[]; until: number } | undefined;

export async function getPublicCatalogueApp(appId: string): Promise<CatalogueApp | undefined> {
  if (cache && cache.until > Date.now()) return cache.apps.find((app) => app.id === appId);
  const apps = await (async () => {
    try {
      const response = await fetch("https://proappstore.online/catalogue.json", {
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as { apps?: CatalogueApp[] };
      if (!Array.isArray(data.apps)) return [];
      const apps = data.apps.filter(
        (app) =>
          app &&
          typeof app.id === "string" &&
          typeof app.name === "string" &&
          app.name.trim() &&
          typeof app.description === "string" &&
          app.description.trim() &&
          typeof app.appUrl === "string",
      );
      cache = { apps, until: Date.now() + 60_000 };
      return apps;
    } catch {
      return [];
    }
  })();
  return apps.find((app) => app.id === appId);
}
