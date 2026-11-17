# Feature Audit and App Store Plan

Written against Beta 1.35.0 (November 2026). Measured in a phone-sized browser (390 px wide) with live league data, signed in as Toe Guano.

## TL;DR

- The data is strong. The map is the problem. The same job lives in two or three places, and the newest, best features sit behind the oldest screens.
- Four screens are over six phone-screens long. Activity is 14.5.
- Research already has the best content in the app (Outlook, Plan, Market, League). It opens on the old My Team page, which is 9.7 screens of things that exist elsewhere.
- There are three separate "find me a trade" tools. One is from Beta 1.8 and is fully replaced.
- App Store: the code can be wrapped today. The blockers are identity (no login), the open trade sheet, chat moderation, push, and one decision about audience.
- This round shipped: Trade Finder must-includes, two bug fixes, one-command releases, CI, and a self-contained app bundle.

## 1. How long each screen is

One "screen" = one phone height (844 px).

| Screen | Length | Verdict |
|---|---|---|
| Activity | 14.5 screens | Too long. Needs a cap and "show more". |
| Research: Overview | 9.7 | Legacy page. Break it up. |
| Research: Market | 6.7 | Long, but it is a list. Add position filter chips at top. |
| Research: Plan | 6.4 | Good content. Collapse deals under each move. |
| Trades | 6.3 | Five jobs stacked on one page. Split. |
| Research: News | 5.7 | Fine for a feed. |
| Rosters | 4.8 | Fine. |
| Standings | 4.6 | Fine. |
| Research: Outlook | 2.7 | Good. |
| Research: League | 1.7 | Good. |
| Vault (landing) | 1.2 | Short, but 7 sub-tabs plus cards above and below them. |

## 2. Where the extra steps come from

### The same job in several places

| Job | Where it lives today | Keep it in |
|---|---|---|
| See offers waiting on me | Trades (Pending), Research Overview (Incoming + Outgoing), Simple mode | Trades only, with a badge on the tab |
| Get a trade idea | Trade Finder, Research Plan, Smart Trade Matchmaker (Beta 1.8) | Finder + Plan. Retire Matchmaker. |
| See my roster | Rosters tab, Research Overview | Rosters (open on my team by default) |
| See my draft picks | Research Overview, Vault Draft Board, trade builder | Rosters, as a "Picks" toggle |
| Past trades | Research Overview (Trade History), Trades (League Trade Feed) | Trade Feed with a "Mine" filter |
| Team value | Research Overview footer, Vault Team Value, Research League map | Research League |
| Head-to-head history | Vault Rivalry Desk, Vault Managers heatmap | One Rivalry screen |
| All-play standings | Vault top card, Vault Managers chart | Vault Managers |
| Change my team | Research hero, Display sheet | Settings |
| Light/dark | Header button, Display sheet | Settings |

### Settings are scattered and partly hidden

- Display: tap the W logo. Nothing says it is a button.
- Notifications: bell in the header.
- Theme: its own header button, plus the Display sheet.
- Commissioner Tools: inside the Research Overview hero.
- Press Room: a hidden emoji at the bottom of Standings.
- Commissioner Docs: hidden behind the version number at the bottom of Research.
- Patch Notes: bottom of Research Overview.

Fix: one Settings sheet behind one gear icon. Team, layout, colors, notifications, patch notes, commissioner section.

### The Trades tab stacks five jobs

Today, top to bottom: Trade Block, Pending, Builder, Finder, Feed. Someone who wants an idea scrolls past the whole builder to reach the Finder. Someone who taps "Load into proposal" gets scrolled back up.

```
TODAY (one long page)            PROPOSED (sub-tabs, like Research)

  Trade Block                     [ Offers ] [ Find ] [ Build ] [ Feed ]
  Pending Trades
  New Trade Proposal   <- 2 screens   Offers: pending + trade block
  Trade Finder         <- buried      Find:   Finder + Shop
  League Trade Feed    <- 3 screens   Build:  proposal + meter
                                      Feed:   league feed, "Mine" filter
```

### Research opens on its weakest page

```
TODAY                               PROPOSED

Overview  <- default, 9.7 screens   Briefing  <- default, 1 screen
Outlook                             Outlook
Plan                                Plan
Market                              Market
League                              League
News      <- off screen             News
Ask       <- off screen             (Ask becomes a button on every pane)
```

### Three layouts

Classic, Compact and Simple are three skins to test on every change (956 extra lines of CSS plus simple.js). Simple exists because Classic overwhelms people. Fixing Classic removes most of the need.

Recommendation: keep Simple for the users who need large text. Retire Compact once Classic is tightened. My pushback on keeping all three: every new feature costs three times the checking, and that is part of why things feel pieced together.

## 3. Feature-by-feature

| Feature | Since | Verdict | Note |
|---|---|---|---|
| Standings, live matchups, Game Flow | 1.33 | Keep | The strongest screen. |
| Schedule Luck chart | early | Keep, move | Belongs in Research League or Vault. It pushes the leaderboard down. |
| Front Page newsletter | 1.10 | Keep | |
| Press Room (newsletter writer) | 1.10 | Update | Asks for an API key in the browser. Model list is out of date. Move behind a Cloud Function. |
| Activity feed + chat + reactions | 1.3x | Keep, cap | Show the last 30 items, then "Show more". |
| Rosters + Waivers | early | Keep | Add a Picks toggle. |
| Trade Block + interest | 1.7 to 1.9 | Keep | Fixed this round: your own team no longer shows as interested in your own player. |
| Trade builder + meter | 1.35 | Keep | |
| Trade Finder + Shop | 1.2x | Keep, promote | Must-includes added this round. |
| League Trade Feed | 1.2x | Keep | Add "Mine" filter. Hide cancelled and countered by default. |
| Research Overview (old My Team) | 1.7 | Break up | Every section has a better home. See table above. |
| Smart Trade Matchmaker | 1.8 | Retire | Uses position totals only. Plan and Finder use values, usage and team mode. |
| Trade History with "regret" points | 1.7 | Merge | Fold the points-since-trade line into the Trade Feed card. |
| Research Outlook / Plan / Market / League | 1.3x | Keep | Best content in the app. |
| Research Ask | 1.3x | Update | Make it a button on each pane ("Ask about this") in place of a tab. |
| Vault: Draft Board, Time Machine, Resumes, Players, Managers | 2.x | Keep | Cut to 5 sub-tabs: Records, Draft, Managers, Players, Rivalry. |
| Vault: Record Book above the tabs, Trauma Ledger below | 2.x | Move | Put both inside a "Records" sub-tab. |
| Commissioner Docs | 2.6 | Rewrite | Still describes hand-editing files and a manual push. See section 6 for the new release steps. |
| Mini-game | 1.33 | Keep | Harmless and hidden. |
| Push notifications | 1.34 | Keep | Needs a native path for the App Store. See section 5. |
| Classic / Compact / Simple | 1.35 | Trim | See above. |

## 4. Making Research special

Five options. I can build any of them.

1. **Trade impact simulator.** Before you send an offer, show "Playoff odds 50% -> 61%. Title odds 11% -> 15%. Dynasty value -796." The season simulator already exists in the Research engine; this runs it twice. *Weakness: odds swing on small samples early in the season, so weeks 1 to 3 need a caveat.*
2. **Weekly Briefing as the landing page.** One screen: your odds and how they moved, your biggest riser and faller, one recommended move, one buy-low that fits your need, one headline. *Weakness: "how they moved" needs last week's odds saved somewhere, which is new storage.*
3. **Watchlist.** Star any player anywhere. Research shows value trend, owner, news, and a one-tap "find a deal for him" (uses the new must-include). *Weakness: saved per device until there are real accounts.*
4. **Trade report card.** Grade every past trade by value then versus value now. Daily value history exists since October 3. *Weakness: only six weeks of history so far, so older trades get a partial grade.*
5. **Scouting report per manager.** Needs, surplus, team mode, what they have accepted before, and the two best deals to pitch. *Weakness: one season of trades is a thin sample for "tendencies".*

My pick: 1 and 2 together. Number 1 is the feature no mainstream fantasy app has. Number 2 fixes the landing page problem at the same time.

## 5. App Store readiness

### The decision that drives everything

| Route | Who can install | Work | Fit |
|---|---|---|---|
| A. TestFlight | People you invite by link (up to 10,000). Builds expire every 90 days. | Smallest | Good for this league now |
| B. Unlisted App Store app | Anyone with the link. No search listing. Apple approves the request. | Medium. Full App Review. | Best fit for one league long term |
| C. Public app for any ESPN league | Everyone | Large. League setup screen, accounts, a backend, private-league login. | Only if you want a product |

All three need an Apple Developer account ($99 per year) and a Mac with Xcode, or a cloud build service.

Recommendation: A first, then B. Build so C stays possible. My pushback on going straight to C: the league ID, the commissioner, team logos and the newsletter are all hard-wired to this league, and private ESPN leagues need login cookies that a public app should never ask users to paste.

### Blockers, in order

| # | Blocker | Why it matters | Needed for |
|---|---|---|---|
| 1 | No login. Identity is "pick your team from a list". The commissioner is whoever picks the team named Toe Guano. | Anyone can act as anyone. Apple rejects apps where user content has no accountable owner. | B, C |
| 2 | Trades, picks and the trade block write to a Google Sheet through Stein with no access control. | The storage URL ships inside the app. | B, C |
| 3 | Chat and custom image reactions have no report or block. | Apple guideline 1.2 requires report, block and a way to act on reports. | A (beta review), B, C |
| 4 | Push is Web Push. | It does not work inside a native shell. Needs Apple push (APNs). The server side in `functions/` can stay. | A, B, C |
| 5 | No privacy policy page. | Required for TestFlight external testers and the store. | A, B, C |
| 6 | Icons are placeholders (the 192 px icon is 557 bytes). | Store needs a 1024 px icon. | A, B, C |
| 7 | ESPN data comes from an unofficial API. Player headshots come from ESPN's image servers. | Review risk for a public listing. Low risk for A and B. | C |
| 8 | Press Room sends an API key from the browser. | Fine as a commissioner-only tool on the web. Remove it from the native build or move it server-side. | B, C |
| 9 | "Refresh and Update Now" prompt. | A store app updates through the store. Hide the prompt in the native build. | A, B, C |

### What already works in your favor

- No build step and no framework. The app is plain files, so wrapping it is simple.
- ESPN's league API accepts requests from a native shell (checked: it answers `capacitor://localhost`).
- The trade, research, activity and push logic are pure modules with 78 tests.
- Firebase is already in place for chat and push, so adding real sign-in uses the same project.

## 6. What shipped this round

**For users (Beta 1.36.0)**

- Trade Finder "Must include". Name up to two of yours, two of theirs, or both. Every suggested deal contains all of them. With "Any team" selected, picking a player under "From them" selects his team.
- Tab titles no longer cut off on phones ("TRAD…", "RESEA…").
- Interest Alerts no longer list your own team.
- Charts load from the app itself (`vendor/chart.umd.js`, byte-identical to the CDN copy). They work offline and inside a native shell.

**Foundation**

- `node scripts/release.js 1.37.0` sets the version in all four files at once. It was a hand-edited checklist across 18 spots.
- `node scripts/release.js --check` fails if the copies drift, or if a file the page loads is missing from the offline cache list.
- `node scripts/build-www.js` builds `www/`: the shippable app with no pipeline, tests or server code, and it fails if the page loads code from another site.
- `capacitor.config.json` points a native shell at `www/`. The app ID in it (`com.woodsonclan.companion`) is a placeholder. It is permanent once an app is submitted, so choose it before then.
- `.github/workflows/ci.yml` runs the version check, the tests and the bundle build on every pull request and every push to main.
- `package.json` at the root: `npm test`, `npm run check`, `npm run build:www`.

**Release steps from now on**

1. `node scripts/release.js <version>`
2. Edit `title` and `notes` in `version.json`.
3. Commit and push. CI confirms everything agrees.

## 7. Roadmap

```
Phase 0  Foundation            DONE this round
   |
Phase 1  Simplify the map      Trades sub-tabs, one Settings sheet,
   |                           break up Research Overview, retire Matchmaker,
   |                           cap Activity, Research Briefing + trade impact
   |
Phase 2  Trust                 Real sign-in tied to a team, commissioner role,
   |                           move trades/picks/block from the Sheet to Firestore,
   |                           chat report + block, privacy policy
   |
Phase 3  Native shell          Capacitor iOS project, Apple push, icons,
   |                           hide web-only prompts, TestFlight
   |
Phase 4  Store                 Unlisted (or public) listing
```

Phase 1 is independent of the App Store and is what your users will feel. Phase 2 has to come before Phase 3, because moving storage after people install a store build means supporting both at once.

Also worth doing in Phase 1 or 2: split `app.js` (7,437 lines, one shared scope) into one file per tab. No behavior change, and it makes every later change safer.

## 8. Decisions I need from you

1. **Audience.** This league only (routes A and B), or any ESPN league (route C)?
2. **Research Overview.** OK to break it up and retire the Matchmaker?
3. **Layouts.** Keep all three, or Classic + Simple?
4. **Research.** Which of the five ideas? My pick is 1 + 2.
5. **Must-include meaning.** I built it as "every named asset is in the deal". If you wanted "at least one of them", say so and I will add a toggle.
6. **Apple.** Do you have a Mac and a developer account?
