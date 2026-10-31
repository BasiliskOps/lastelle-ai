# Lastelle AI

Lastelle AI is a one-person AI solutions architecture practice run by Damien Rosecraft. It designs and builds production architecture for large language models and agentic AI systems, and releases software products built in the spirit of effective acceleration (e/acc).

Website: https://lastelle.ai/

## Practice

Solutions architecture covers model and vendor selection, retrieval and memory design, orchestration, and evaluation harnesses, fitted to each client's data, stack, and risk posture. Agentic systems are workflows of cooperating agents with human review checkpoints placed where judgment matters. Products are released under the Lastelle AI name as they mature.

## Method

Engagements run in three phases: Survey, Architect, and Build and hand over. Each one ends with working software the client owns outright, delivered with documentation and evaluation harnesses.

## Contact

Email damien@lastelle.ai, or connect on [LinkedIn](https://www.linkedin.com/in/thirdechelon) and [X](https://x.com/clangnosis).

## Repository

This repository is the static source of the Lastelle AI website, served by GitHub Pages. Machine-readable summaries for language models live at `llms.txt` and `llms-full.txt`.

The hero scene is edited in `js/hero.js` and served as the single bundle `js/hero.min.js` (three.js r170 inlined, no import map). Rebuild after any change to `js/hero.js`:

```
npx esbuild@0.24.0 js/hero.js --bundle --format=esm --minify --target=es2020 --outfile=js/hero.min.js
```

with `three@0.170.0` installed so the `three` imports resolve.
