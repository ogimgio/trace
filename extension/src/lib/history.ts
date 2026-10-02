export interface VisitRecord {
  visitId: string;
  url: string;
  title: string;
  visitTime: number;
  transition: string;
  referringVisitId: string;
}

const GET_VISITS_CONCURRENCY = 50;

// Chrome conserva circa 90 giorni di cronologia: con startTime = 0 si ottiene tutto ciò che c'è.
export async function collectVisitsSince(startTime: number): Promise<VisitRecord[]> {
  // search() restituisce un elemento per URL (con l'ultima visita), getVisits() le singole visite.
  const items = await chrome.history.search({ text: '', startTime, maxResults: 1_000_000 });
  const visits: VisitRecord[] = [];

  for (let i = 0; i < items.length; i += GET_VISITS_CONCURRENCY) {
    const chunk = items.slice(i, i + GET_VISITS_CONCURRENCY);
    await Promise.all(
      chunk.map(async (item) => {
        if (!item.url) return;
        for (const v of await chrome.history.getVisits({ url: item.url })) {
          if (v.visitTime === undefined || v.visitTime < startTime) continue;
          visits.push({
            visitId: v.visitId,
            url: item.url,
            title: item.title ?? '',
            visitTime: v.visitTime,
            transition: v.transition,
            referringVisitId: v.referringVisitId,
          });
        }
      }),
    );
  }

  return visits.sort((a, b) => a.visitTime - b.visitTime);
}
