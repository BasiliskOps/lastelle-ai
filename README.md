# Lastelle AI

Lastelle AI Corporation builds agentic systems and AI-embedded hardware as proprietary products, from algorithmic anomaly detection in capital markets to resource prospecting across the solar system.

Website: https://lastelle.ai/

## Products

BARDT is institutional-grade market intelligence built on algorithmic anomaly detection, earning through licensed API access and proprietary capital deployed on its own signals. Probe is a resource prospecting program spanning the solar system. Lastelle Hardware is a series of in-house systems with AI embedded at the device level, agentically interoperable across the line.

## Contact

Email damien@lastelle.ai, or connect on [LinkedIn](https://www.linkedin.com/in/thirdechelon) and [X](https://x.com/clangnosis).

## Repository

This repository is the static source of the Lastelle AI website, served by GitHub Pages. Machine-readable summaries for language models live at `llms.txt` and `llms-full.txt`.

The hero scene is edited in `js/hero.js` and served as the single bundle `js/hero.min.js` (three.js r170 inlined, no import map). Rebuild after any change to `js/hero.js`:

```
npx esbuild@0.24.0 js/hero.js --bundle --format=esm --minify --target=es2020 --outfile=js/hero.min.js
```

with `three@0.170.0` installed so the `three` imports resolve.
