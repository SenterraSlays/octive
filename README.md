# OCTIVE Rankings website

An osu!-style ranking site. The page itself is static and hosted on **GitHub Pages**; the live
ranking comes from a tiny **Cloudflare Worker** (free plan, no card needed) that holds the Unity
service-account key as a secret and reads the game's global PP leaderboard and each player's public
card and avatar from Unity Gaming Services. No server, no cost.

**Keep this in its own repository.** Don't publish the game repository: it contains the remixed
songs, which can't be shared publicly.

## 1. The website (GitHub Pages)

1. Create a public repository (for example `octive-rankings`) and upload `index.html`, `app.js`,
   `style.css`, `data` and `avatars`.
2. **Settings → Pages:** Source *Deploy from a branch*, branch `main`, folder `/ (root)`.

## 2. A Unity service account (read-only)

In the Unity dashboard (cloud.unity.com → Administration → Service accounts → New), give it these
**project roles** on the OCTIVE project: *Cloud Save Viewer* and a Leaderboards role that can read
scores (*Leaderboards Viewer*, or *Leaderboards Admin* if no viewer role is offered). Then
**Add key** and copy the *Key ID* and *Secret key* (the secret is shown once). Also note the
*Project ID* and the *Environment ID* of `production` (Project settings → Environments).

## 3. The Worker (Cloudflare)

1. Sign up at **cloudflare.com** (free plan).
2. **Workers & Pages → Create → Create Worker**, name it `octive-rankings`, **Deploy**.
3. **Edit code**: replace everything with the contents of `worker/worker.js`, then **Deploy**.
4. The Worker's **Settings → Variables and Secrets → Add**, type **Secret**, four times:

   | Name | Value |
   |---|---|
   | `UGS_KEY_ID` | the service account Key ID |
   | `UGS_SECRET_KEY` | the service account Secret key |
   | `UGS_PROJECT_ID` | the Project ID |
   | `UGS_ENVIRONMENT_ID` | the production Environment ID |

   Then **Deploy** again.
5. Open `https://octive-rankings.<your-subdomain>.workers.dev/leaderboard`. You should see JSON
   with a `players` list (or an `error` that says what's missing).

## 4. Connect them

In the GitHub repository, open `app.js` → **Edit** (pencil), set

```js
const WORKER_URL = "https://octive-rankings.<your-subdomain>.workers.dev";
```

and commit. The site shows the live ranking within a minute (GitHub Pages redeploys on commit).

## Updating

After a game update that changes the site (like v1.1.3: online status, bios, more stats), paste the new
`worker/worker.js` into the Worker (**Edit code → Deploy**) and upload the new `index.html`, `app.js`
and `style.css` to the website repository.

## Notes

* The Worker refreshes the ranking at most once a minute, each player's card every 10 minutes and
  avatars only when they change, which keeps it inside Unity's request limits.
* Special accounts (the DEV badge) are listed by Unity player ID in `app.js` (`ROLES`), matching
  the game's `PlayerRoles.cs`.
* Set `DOWNLOAD_URL` in `app.js` to your itch.io or GitHub Releases page to show a Download link.
* `.github/workflows/update-leaderboard.yml` and `scripts/update.mjs` are an alternative that
  updates `data/leaderboard.json` with GitHub Actions instead of a Worker; it isn't needed with the
  Worker.
