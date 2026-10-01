# Meme librarian

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/jacksoncurrie/meme-librarian"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"/></a>

Every minute, a Cloudflare Agent searches the web for a funny image, looks at it,
decides which folder it belongs in, files it into R2, and streams each step to a
live dashboard.

Architecture: a cron-triggered Worker forwards to one Durable Object agent
(`Librarian`) that calls Tavily for image search, Workers AI (`@cf/cloudflare/clef-flash`)
to pick a folder, stores the bytes in R2, and broadcasts each phase over a
WebSocket to a React dashboard.

## How it works

1. **Search** — the agent rotates through a fixed list of queries and calls the
   Tavily search API with image results enabled.
2. **Find** — one random image is selected from the results.
3. **Decide** — Workers AI classifies the image into one of
   `tech_humor`, `cats`, `gym_fails`, `signs_gone_wrong`, or `dad_jokes`, with
   per-folder probabilities and a confidence score.
4. **File** — the image bytes are validated, hashed, and written to R2 at
   `images/<YYYY-MM-DD>/<sha256>.<ext>`. Already-seen URLs are skipped.
5. **Broadcast** — every phase is sent to connected dashboards in real time, and
   filed items are kept in agent state for the gallery.

The dashboard also supports **Run now** (trigger a cycle immediately) and
**Pause** / **Resume**.

## Local development

```bash
npm install
npm run dev
```

You need a [Tavily](https://tavily.com) API key. Copy `.dev.vars.example` to
`.dev.vars` and set `TAVILY_API_KEY`. Workers AI uses the `AI` binding, which is
configured with `"remote": true`, so a Cloudflare login (`wrangler login`) is
also required.

Open [http://localhost:5173](http://localhost:5173) and use the **Run now**
button, or trigger a cycle directly:

```bash
# Vite dev server (npm run dev)
curl -X POST http://localhost:5173/agents/librarian/run-cycle

# or, if you are running `wrangler dev` instead
curl -X POST http://localhost:8787/agents/librarian/run-cycle
```

> The cron trigger (`* * * * *`) only fires once the Worker is deployed. Locally,
> use **Run now** or the cURL command above.

## Project structure

```
src/
  server.ts    # Librarian agent, cron handler, R2 routing, Tavily + AI
  app.tsx      # Live dashboard (timeline, folders, gallery)
  client.tsx   # React entry point
  styles.css   # Layout and CSS keyframe animations
```

## Configuration

- `AI` — Workers AI binding (`remote: true`)
- `BUCKET` — R2 bucket for filed images
- `TAVILY_API_KEY` — secret used for image search
- `triggers.crons` — `["* * * * *"]`

Images are served back to the dashboard through `GET /img/<key>`, and the agent
state is exposed at `GET /api/state`.
