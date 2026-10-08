/** A page or the planner's bounded summary cannot prove directory-wide absence. */
export function exhaustiveListingItems(data = {}, args = {}) {
  if ((args.offset ?? 0) !== 0 || (data.listingOffset ?? 0) !== 0
    || data.listingTruncated === true || data.listingHasMore === true) return null;
  const full = Array.isArray(data.listingItems);
  const items = full ? data.listingItems : data.items;
  if (!Array.isArray(items)) return null;
  if (data.listingTotalEntries !== undefined && data.listingTotalEntries !== null) {
    return full && Number.isSafeInteger(data.listingTotalEntries)
      && data.listingTotalEntries === items.length ? items : null;
  }
  const limit = Number(args.maxItems ?? 100);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  // Legacy data.items contains at most 30 entries, even when the adapter read more.
  return items.length < Math.min(limit, full ? 1000 : 30) ? items : null;
}
