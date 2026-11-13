# Lastelle AI

Lastelle AI Corporation is an artisanal AI workshop synthesizing agentic systems and AI-embedded hardware from human craft and machine intelligence.

Website: https://lastelle.ai/

## Work

Current work spans aerospace and AI-embedded hardware.

## Contact

Email damien@lastelle.ai, or connect on [LinkedIn](https://www.linkedin.com/in/thirdechelon) and [X](https://x.com/clangnosis).

## Repository

This repository is the static source of the Lastelle AI website, served by Cloudflare. Machine-readable summaries for language models live at `llms.txt` and `llms-full.txt`.

The hero scene is edited in `js/hero.js` and served as the single bundle `js/hero.min.js` (three.js r170 inlined, no import map). Rebuild after any change to `js/hero.js`:

```
npx esbuild@0.24.0 js/hero.js --bundle --format=esm --minify --target=es2020 --outfile=js/hero.min.js
```

with `three@0.170.0` installed so the `three` imports resolve.

The products orrery is `js/orrery.js` (plain WebGL2, no build step): the Sun and the eight planets, orbiting continuously. Its surface maps in `assets/orrery/` are derived from NASA LRO/LOLA lunar data (public domain) and [Solar System Scope](https://www.solarsystemscope.com/textures/) Earth textures, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
