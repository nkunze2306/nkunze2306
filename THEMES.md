# Themes

Ein Overlay ist eine Animationsschicht, die `generate.mjs` vor `</svg>` in `stats.svg` einfügt. Gewählt wird über `theme.json`
(per Hand oder über die Leiste „Theme & look“ auf der Website, nur für den Owner). Mehrere Overlays lassen sich kombinieren.

```json
{
  "overlays": ["autumn", "snow"],
  "ring": "orbit",
  "density": 3, "piles": true, "wind": true, "reduceMotion": true,
  "options": { "snow": { "flakes": 80, "icicles": true } }
}
```

| Overlay     | Einstellungen |
| ----------- | ------------- |
| butterflies | `density` |
| autumn      | `density`, `piles`, `wind` (Datei `autumn.mjs`) |
| roses       | `options.roses`: `color`, `silver` (0–1), `density` (Faktor) |
| snow        | `options.snow`: `flakes`, `piles`, `wind`, `icicles`, `sparkle`, `tint` |
| sakura      | `options.sakura`: `color`, `branches`, `blossoms`, `petals`, `landing`, `sway` |
| rain        | `options.rain`: `drops`, `angle`, `dim`, `puddles`, `splashes`, `mist`, `lightning`, `tint` |
| night       | `options.night`: `dark`, `fireflies`, `stars`, `roses`, `glow`, `color` |

`theme.mjs` prüft alles (`normalizeTheme`): unbekannte Overlays, Werte außerhalb der Reglerbereiche und ungültige Farben fallen auf den Standard zurück.
Mit `reduceMotion` blendet eine Media-Query die Bewegung aus. Autumn lässt die Blätter liegen, die Themes aus `themes/` verschwinden dann ganz.
Intern hat jedes Theme außerdem `loop` (Sekunden pro Durchlauf) und `seed` (gleicher Seed = gleiches Bild); beides ist nicht einstellbar.

## Neues Theme

1. `themes/<id>.mjs` mit `export function <id>Layer(W, H, cards, opts)` → SVG-String und `export const <ID>_DEFAULTS`. `cards` sind die Kacheln `{ x, y, w, h }`. Hilfen in `themes/lib.mjs` (RNG, Farben, Pixel-Runs, Twinkle, Dither).
2. In `themes/index.mjs` eintragen: `{ id, label, description, defaults, controls, render }`.
   `controls` erzeugt die Regler der Website-Leiste automatisch (`range`, `toggle`, `swatches`; `scale`/`unit`/`step` optional) und legt die gültigen Wertebereiche für `theme.mjs` fest.
3. Farbe für das Icon in `index.html` (`ACC`) und, falls das Theme vor anderen liegen soll, die Reihenfolge `order` in `generate.mjs` und `ORDER` in `index.html`.
4. `node preview-themes.mjs <id>` rendert `previews/<id>.svg` mit Demo-Daten.

Regeln: nur SVG/SMIL (kein Script, keine Webfonts), Grundzustand = „fertiger“ Zustand, deterministisch (`rng(seed)`), Größenbudget grob unter 500 KB bei der Demo-Höhe.
