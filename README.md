# Callsheet

A free planner for writers, directors, actors and musicians: projects and their stages, a daily plan, deadlines, jobs, songs and releases. You can share any project with other people as a **Viewer** or **Editor**, the same way Google Drive works.

- **Private by default.** Nobody sees anything of yours unless you share a project with them, or you choose to make your profile (and particular projects) public.
- **No AI and no running costs.** It's a static web page on GitHub Pages plus a free Supabase database. Nobody pays anything to use it.
- **Works on a phone.** Open it in Safari or Chrome and use "Add to Home Screen".

## How it fits together

| Piece | What it does | Cost |
|---|---|---|
| `index.html` | The whole app | GitHub Pages, free |
| Supabase | Accounts, database, file storage | Free tier |
| `supabase/schema.sql` | Tables plus the privacy rules (row-level security) | — |

The privacy rules live in the database itself, so even someone who edits the web page can't read projects that weren't shared with them.

## One-time setup (about 10 minutes)

1. **Create the database.** Sign up at [supabase.com](https://supabase.com), click **New project**, pick a name and a database password, and choose the London region.
2. **Add the tables and rules.** In your Supabase project, open **SQL Editor → New query**. Paste in the whole of `supabase/schema.sql` and click **Run**. It should say "Success".
3. **Sign-in settings.** Go to **Authentication → Sign In / Providers → Email**. For the easiest start, turn **Confirm email** off; you can turn it back on later. Then go to **Authentication → URL Configuration** and set **Site URL** to your app's address (step 5).
4. **Connect the app.** Go to **Project Settings → API**. Copy the **Project URL** and the **anon public** key into `config.js`:
   ```js
   window.CS_CONFIG = { url: 'https://xxxx.supabase.co', anonKey: 'eyJ…' };
   ```
   Both are safe to publish. The anon key can only do what the privacy rules allow.
5. **Publish.** On GitHub, open this repo's **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, then branch `main` and folder `/ (root)`. After a minute the app is live at `https://<your-username>.github.io/callsheet/`.

If `config.js` is left empty, the app runs in demo mode and saves only to that browser.

## Calendars

**Your calendars in Callsheet.** Settings → *Your calendars* → paste a calendar link: Apple (public calendar link), Google (secret iCal address), Outlook (published ICS link), or a rota app like Deputy. Callsheet shows those events and plans creative time around them, with a gap around work shifts. It only reads them. They refresh when you open the app (at most every 20 minutes) and when you press *Sync now*.

**Callsheet in your calendar.** The same page has *Add to Apple Calendar* and *Add to Google Calendar* buttons. They subscribe your calendar app to a private link with your booked sessions, events and followed deadlines. Apple refreshes about hourly; Google can take several hours. *Make a new link* turns the old one off.

Both run through a small free Supabase server function (`supabase/functions/calendar`), because browsers can't read other sites' calendars directly.

## Server updates (one-time setup)

Database changes (`supabase/migrations`) and server functions (`supabase/functions`) are deployed by GitHub Actions whenever they change:

1. In Supabase, open your account menu (top right) → **Account preferences → Access Tokens → Generate new token**. Name it `github` and copy it.
2. On GitHub, open this repo's **Settings → Secrets and variables → Actions → New repository secret**. Name: `SUPABASE_ACCESS_TOKEN`; value: the token.
3. Open the **Actions** tab → **Update Supabase** → **Run workflow**.

To do it by hand instead: run each file in `supabase/migrations` in the SQL Editor. Then go to **Edge Functions → Deploy a new function → Via editor**, name it `calendar`, paste in `supabase/functions/calendar/index.ts` and deploy. Finally, in that function's settings, turn **Verify JWT** off.

## Moving over from the Claude version

Sign in, go to **Settings → Account → Import file**, and choose the export file. Projects, tasks, deadlines, jobs, songs, settings, covers and documents all come across.

## Sharing

Open a project and press **Share**. Add someone by email as a Viewer or an Editor.

- If they don't have an account yet, they get access as soon as they sign up with that email.
- Viewers see the project and its steps. Editors can change both.
- Only the owner can delete a project.
- Anyone can leave a project they've been added to.

The same box has a public-profile switch. When it's on, you choose which parts of the project appear: logline, genres, stage and cover. Steps, documents, notes and people are never public.

## Development

`index.html` is generated from the original single-page version (`build/source.html`) by `build/make.py`, which adds the Supabase back end in `build/chunk_backend.js`:

```
python3 build/make.py
```
