// Gemeinsame Regeln für theme.json (genutzt von generate.mjs und apply-theme.mjs).
// Nur bekannte Schlüssel und Werte kommen durch, alles andere fällt auf den Standard zurück.
// Ältere Formate { overlay } und { theme, autumn: { piles, wind } } werden weiter verstanden.
export const OVERLAYS = ['butterflies', 'autumn'];
export const RINGS = ['classic', 'orbit', 'rank', 'rarity'];

export function normalizeTheme(j = {}) {
  if (!j || typeof j !== 'object') j = {};
  const list = Array.isArray(j.overlays) ? j.overlays : [j.overlay ?? j.theme ?? 'autumn'];
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  return {
    overlays: OVERLAYS.filter((o) => list.includes(o)),
    ring: RINGS.includes(j.ring) ? j.ring : 'classic',
    density: Math.min(5, Math.max(1, Math.round(Number(j.density) || 3))),
    piles: bool(j.piles, (j.autumn?.piles ?? 2) > 0),
    wind: bool(j.wind, bool(j.autumn?.wind, true)),
    reduceMotion: bool(j.reduceMotion, true),
  };
}
