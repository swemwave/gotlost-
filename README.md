# SAIT Navigator (Panorama + Floor Plan + Directory)

Three static pages that reuse the Marzipano export:
- `index.html` keeps the original-style pano viewer with scene list, autorotate, and fullscreen controls.
- `floor-plan.html` builds a graph-style floor plan directly from `APP_DATA` and lets you jump into any stop.
- `directory.html` lists every scene with filters and search.

All files are static, so everything remains GitHub Pages friendly.

## Project map
```
app-files/
|- index.html        # Panorama UI
|- floor-plan.html   # SVG floor plan view
|- directory.html    # Filterable directory
|- style.css         # Shared design tokens + layouts
|- index.js          # Page-specific logic (auto-detects by body data attribute)
|- data.js           # Generated Marzipano scene data
|- vendor/           # screenfull + marzipano libs
|- tiles/, img/      # Cube tiles + icons from the original export
```

## Local preview
1. Serve the folder with any static server:
   ```powershell
   npx serve .
   # or
   python -m http.server 4173
   ```
2. Visit `/index.html` for the pano, `/floor-plan.html` for the graph view, `/directory.html` for the list.
3. Try the fullscreen buttons on each page (uses `screenfull.js` with a fallback to `requestFullscreen`).

## Deploying to GitHub Pages
1. Push the folder contents to the root of a GitHub repository.
2. Open **Settings > Pages**, choose `Deploy from a branch`, pick your branch (e.g., `main`) and the `/ (root)` folder.
3. Save to trigger the static publish pipeline. GitHub will return a `https://<user>.github.io/<repo>/` URL.

## Customization notes
- The pano UI reads query parameters (`?scene=<id>`). Both the floor plan and directory link back to index with that query so you can deep link to a specific stop.
- To tweak the pano styling, edit the `.viewer-*` sections in `style.css`. Hotspot buttons mimic the original Marzipano look.
- Floor plan layout is controlled by `zoneRadius()` and `zoneColor()` inside `index.js`.
- Directory filters live in `filterConfig` within `index.js`.

## Troubleshooting
- Pano blank: confirm `vendor/marzipano.js` is still referenced before `index.js` on every page.
- Fullscreen not working: check that `vendor/screenfull.min.js` is present; the fallback only works if `document.documentElement.requestFullscreen` exists.
- Tiles missing: the viewer expects the original folder structure (`tiles/<scene-id>/<z>/<f>/<y>/<x>.jpg`).

Once pushed, every update to `index.html`, `floor-plan.html`, or `directory.html` is automatically redeployed by GitHub Pages.
