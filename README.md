# Seshat

RSVP speed reader for PDFs, fully client-side. The PDF stays visible while a
movable overlay flashes one word at a time at its optimal recognition point.

- Pick the start point anywhere: press `S` (or `Alt+click`) and click a word
- Adaptive pacing, ETA, bookmarks sidebar, working PDF links
- OLED-friendly dark UI, plus inverted page mode (`I`) that spares images
- Remembers recent files and your last reading position
- Rejoins hyphenated line breaks and drop caps into whole words

Pure static files — host anywhere (e.g. GitHub Pages) and open `index.html`.
Try it with the bundled `sample.pdf` (`?file=sample.pdf`). Space = play/pause,
arrows = step, `R` = overlay, `T` = toggle toolbar, `☰` = contents.

Built with [PDF.js](https://mozilla.github.io/pdf.js/) (vendored in `lib/`).
This project is 100% AI generated, with [Claude Code](https://claude.com/claude-code).
