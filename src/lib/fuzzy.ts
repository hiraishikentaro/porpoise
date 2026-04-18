/**
 * 素朴な fuzzy マッチ。文字を順番に見つけて、連続マッチや単語境界にボーナス。
 * 見つからなければ null を返す。
 */
export function fuzzyMatch(
  needle: string,
  haystack: string,
): { score: number; indices: number[] } | null {
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let prev = -2;
  let hi = 0;
  for (let ni = 0; ni < n.length; ni++) {
    const target = n[ni];
    while (hi < h.length && h[hi] !== target) hi++;
    if (hi >= h.length) return null;
    indices.push(hi);
    if (hi === prev + 1) score += 10;
    else score += 1;
    if (hi === 0 || /[._\- ]/.test(h[hi - 1] ?? "")) score += 5;
    prev = hi;
    hi++;
  }
  score -= Math.floor(h.length / 20);
  if (indices.length > 0) score -= Math.floor(indices[0] / 4);
  return { score, indices };
}
