# Hand-added team logos

Use this folder when a team's ESPN logo won't load in the app (for example, the original image link is dead).

1. Save the logo here as a square image, ideally 256x256 or smaller. PNG, JPG, GIF, WEBP, or SVG all work.
2. Add a line to `index.json` that maps the ESPN team ID to the file name:

```json
{
  "3": "toe-guano.png"
}
```

Logos here always win over the nightly ESPN copy. Team IDs are listed in `data/logos/index.json` once the nightly job has run.
