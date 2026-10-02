export interface VisitRecord {
  visitId: string;
  url: string;
  title: string;
  visitTime: number;
  transition: string;
  referringVisitId: string;
}

const GET_VISITS_CONCURRENCY = 50;

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]$|0\.0\.0\.0$)|\.local$|\.internal$/;

// Filtro locale: non lasciano mai il browser i file del computer (file://), le pagine interne
// (chrome://, estensioni), localhost e gli indirizzi di reti private (router, NAS, intranet).
export function isShareable(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (protocol === 'https:' || protocol === 'http:') && !PRIVATE_HOST.test(hostname.toLowerCase());
  } catch {
    return false;
  }
}

// Chrome conserva circa 90 giorni di cronologia: con startTime = 0 si ottiene tutto ciò che c'è.
export async function collectVisitsSince(startTime: number): Promise<VisitRecord[]> {
  // search() restituisce un elemento per URL (con l'ultima visita), getVisits() le singole visite.
  const items = await chrome.history.search({ text: '', startTime, maxResults: 1_000_000 });
  const visits: VisitRecord[] = [];

  for (let i = 0; i < items.length; i += GET_VISITS_CONCURRENCY) {
    const chunk = items.slice(i, i + GET_VISITS_CONCURRENCY);
    await Promise.all(
      chunk.map(async (item) => {
        if (!item.url || !isShareable(item.url)) return;
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
