/**
 * Publisher feeds that have been verified from the publisher's own public RSS page.
 * This is a curated allowlist, not a feed autodiscovery mechanism.
 */
export const newsPublisherFeedCatalog = Object.freeze([
  Object.freeze({
    id: 'yonhapnewstv-latest',
    label: '연합뉴스TV 최신 뉴스',
    aliases: Object.freeze(['연합뉴스TV', '연합뉴스 TV', '연합뉴스티비', 'Yonhap News TV']),
    feedUrl: 'https://www.yonhapnewstv.co.kr/browse/feed/',
    publisherHosts: Object.freeze(['www.yonhapnewstv.co.kr', 'yonhapnewstv.co.kr']),
    headlineMatchWindowMs: 6 * 60 * 60 * 1000,
    officialFeedPage: 'https://www.yonhapnewstv.co.kr/add/rss',
    checkedAt: '2026-09-29',
    usageRestrictions: Object.freeze({
      commercialUse: 'prohibited-pending-rights-review',
      aiProcessing: 'prohibited-by-publisher-notice-pending-rights-review',
      redistribution: 'prohibited-by-publisher-notice-pending-rights-review',
      notice: '공식 RSS 안내는 영리 목적의 배포·사용을 금하고, 기사 페이지는 무단 전재·재배포 및 AI 학습·활용 금지를 고지함',
      sourceUrl: 'https://www.yonhapnewstv.co.kr/add/rss',
      aiUseNoticeUrl: 'https://www.yonhapnewstv.co.kr/news/AKR20260416112606LUi'
    })
  })
]);

export function findNewsPublisherByUrl(value, catalog = newsPublisherFeedCatalog) {
  try {
    const host = new URL(String(value ?? '')).hostname.toLowerCase();
    return catalog.find(source => source.publisherHosts?.includes(host)) ?? null;
  } catch { return null; }
}

export function findNewsPublisherForHeadline(item, catalog = newsPublisherFeedCatalog) {
  const byHost = [item?.publisherHomepageUrl, item?.sourceUrl, item?.url]
    .map(value => findNewsPublisherByUrl(value, catalog)).find(Boolean);
  if (byHost) return byHost;
  const source = String(item?.source ?? '').normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('ko-KR');
  return catalog.find(entry => (entry.aliases ?? []).some(alias => source.includes(
    alias.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('ko-KR')
  ))) ?? null;
}

export function isNewsPublisherAiProcessingRestricted(source) {
  return String(source?.usageRestrictions?.aiProcessing ?? '').startsWith('prohibited');
}

export function findNewsPublisherFeed(text) {
  const normalized = String(text ?? '').replace(/\s+/gu, '').toLocaleLowerCase('ko-KR');
  for (const source of newsPublisherFeedCatalog) {
    for (const alias of source.aliases) {
      const normalizedAlias = alias.replace(/\s+/gu, '').toLocaleLowerCase('ko-KR');
      const index = normalized.indexOf(normalizedAlias);
      if (index < 0) continue;
      const before = normalized.slice(0, index);
      const after = normalized.slice(index + normalizedAlias.length);
      if (/^(?:말고|제외하고|제외|아닌|대신)/u.test(after)) continue;
      const sourceSelectorFollows = /^(?:에서|의|뉴스(?:피드)?(?:에서)?|헤드라인|속보|기사|rss|피드)/u.test(after);
      const sourceSelectorPrecedes = /(?:뉴스|헤드라인|속보|기사)(?:를|가|는|의)?$/u.test(before)
        && /^(?:에서|의|로)/u.test(after);
      if (sourceSelectorFollows || sourceSelectorPrecedes) return source;
    }
  }
  return null;
}
