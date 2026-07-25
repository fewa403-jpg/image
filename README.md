# Image Editor

A full browser-based image editor: crop, rotate, adjustments, filter presets,
text, stickers/overlays, brush/retouch, layers — plus AI tools (background
removal, upscaling, style transfer, object removal), free.

## Stack
- **Frontend:** Fabric.js (canvas engine) + TensorFlow.js/Magenta (client-side
  style transfer) — plain HTML/CSS/JS, no build step
- **Backend:** Node/Express, proxies AI requests to Hugging Face's free
  Inference API (keeps your API token secret, avoids CORS issues)

## AI features — what's free and how
- **Background Removal** now runs **on our own server**, via `onnxruntime-node`
  running a small (~4.7MB) U2Net-portable model — no Hugging Face, no API
  key, no rate limit. The model file downloads automatically the first time
  the feature is used (from a public GitHub release, cached on disk after
  that — subsequent calls are fast). This is genuinely free: it's your own
  server's compute, not a third-party service.
- **Enhance & Upscale** and **Style Match** run fully client-side in the
  browser — same as before, no server involved.
- **Cutout tab** (Magic Wand / Erase / Restore) is a manual, zero-dependency
  fallback/refinement tool — use it to touch up anything the AI removal
  didn't get quite right, or as a substitute if you'd rather not run the
  local model at all.
- **Remove Object** (inpainting) is the one feature still calling Hugging
  Face's free Inference API — marked "experimental" in the UI since that
  free tier has been unpredictable.

### Installing the new dependencies
```bash
cd server
npm install
```
This pulls in `onnxruntime-node` and `sharp` (already added to
`package.json`) — no separate manual install step needed beyond the usual
`npm install`.

### Honest notes on the local model
- **First request per server restart** downloads the model file (~4.7MB) —
  takes a few extra seconds. After that it's cached on disk and instant.
- **Render's free tier has 512MB RAM** — this model is small enough to run
  comfortably there, but very large photos may be slow. Consider resizing
  huge uploads before running this if you hit memory issues.
- **Quality**: U2Net-portable is a solid, widely-used general-purpose
  background remover (it's what several popular free bg-removal tools are
  built on), but it's not going to match a paid, state-of-the-art model on
  every photo — especially fine detail like hair strands. That's what the
  Cutout tab's Erase/Restore brushes are for.
- If the model download URL ever stops working, the fix is a one-line
  change: update `MODEL_URL` in `server/routes/ai.js`.

## If you still want to set up Hugging Face (only needed for Remove Object)

1. Go to [huggingface.co](https://huggingface.co) and create a free account
2. Go to **Settings → Access Tokens** → **New token** (read access is enough)
3. Copy the token

## Running locally
```bash
cd server
npm install
export HF_TOKEN=hf_your_token_here    # Windows PowerShell: $env:HF_TOKEN="hf_..."
npm start
```
Open **http://localhost:4001**.

## Deploying (same pattern as before: GitHub → Render)
1. Push this folder to a GitHub repo
2. Render → New Web Service → connect the repo
3. Root directory: `server`, Build: `npm install`, Start: `npm start`
4. **Environment tab → add `HF_TOKEN`** with your token — this is required for
   3 of the 4 AI features to work
5. Deploy

## Honest limitations — please read before relying on the AI features
These are **free, community-hosted** models, not a paid, SLA-backed API. Some
things to expect:

- **Cold starts:** if a model hasn't been called recently, Hugging Face can
  take 20-60 seconds to spin it up. The server already retries automatically
  a few times — if it still times out, just try again a minute later.
- **Model availability changes:** Hugging Face's free Inference API doesn't
  guarantee every model stays hosted forever. If a feature suddenly starts
  failing, the model behind it may have been retired — the fix is a one-line
  change in `server/routes/ai.js` (the `MODELS` object at the top) to swap in
  a currently-available alternative.
- **Inpainting (Remove Object) request format:** Hugging Face's inference
  contract for diffusion-based inpainting models can vary slightly by model.
  The current implementation sends the image/mask the way
  `runwayml/stable-diffusion-inpainting` expects as of when this was built —
  if you get errors here specifically, check that model's current API page
  on huggingface.co for the exact expected request shape.
- **Rate limits:** free tier usage is capped. Fine for personal/demo use;
  not meant for high-traffic production load.
- **Style Transfer** is the one fully reliable, unlimited feature here — it
  runs on the visitor's own device via TensorFlow.js, no server call at all.

## Known gaps in the manual editor (honest, not hidden)
- **Clone-stamp** (copying pixels from one area to another) isn't included —
  it's a genuinely complex tool. What's included instead is a **Blur Retouch**
  brush, which softens the area you paint over (good for skin/blemish
  softening, not for removing whole objects — use the AI "Remove Object" tool
  for that).
- **Eraser** isn't a separate tool yet — delete a layer instead via the
  Layers panel if you added something by mistake.

## Project structure
```
image-editor-app/
├── server/
│   ├── index.js
│   ├── routes/ai.js       # the 3 Hugging Face proxy endpoints
│   └── package.json
└── public/
    ├── index.html
    ├── style.css
    └── app.js              # Fabric.js editor + AI calls
```
