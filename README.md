# NCTS PureLight — Online School

Student + instructor portals. Upload/create books and tests, auto-grade and manually grade,
email students. Backend: Supabase (kingdom-wealth). Email: Resend. Hosting: Vercel.

---

## PART 1 — DATABASE (Supabase)

1. Go to https://supabase.com/dashboard and open the **kingdom-wealth** project.
2. Left sidebar → **SQL Editor** → **New query**.
3. Open the file `supabase/schema.sql` from this project, copy ALL of it, paste into the editor.
4. Click **Run**. You should see "Success. No rows returned."
   (Safe to run again later — it won't duplicate anything.)

## PART 2 — GET YOUR SUPABASE KEYS

1. In Supabase, left sidebar → **Project Settings** → **API**.
2. Copy the **Project URL** (looks like `https://lmugkdwjijhmjhlqnmyk.supabase.co`).
3. Copy the **anon public** key (the long one labeled `anon` / `public`).
   Keep these two for Part 5.

## PART 3 — EMAIL (Resend)

1. Go to https://resend.com and create a free account (or sign in).
2. Left sidebar → **API Keys** → **Create API Key** → copy the key (starts with `re_`).
3. Left sidebar → **Domains** → **Add Domain** → enter `thehealedplace.org`.
4. Resend shows DNS records (SPF, DKIM). Add them at your domain registrar, then click **Verify**.
   - Until the domain is verified, email only works to your OWN address using the test
     sender `onboarding@resend.dev`. After verification you can send to anyone.

## PART 4 — PUT THE CODE ON GITHUB

1. Make sure `node_modules` is NOT included (the `.gitignore` already excludes it).
2. Create a new repo under your account **elainebenson2014-sketch** named `PureLight`.
3. From this project folder run:
   ```
   git init
   git add .
   git commit -m "Initial NCTS PureLight"
   git branch -M main
   git remote add origin https://github.com/elainebenson2014-sketch/PureLight.git
   git push -u origin main
   ```

## PART 5 — DEPLOY ON VERCEL

1. Go to https://vercel.com (org **the-healed-place**) → **Add New** → **Project**.
2. Import the **PureLight** GitHub repo.
3. Framework Preset should auto-detect **Vite**. Leave build settings as default.
4. Open **Environment Variables** and add these FOUR (exact names):

   | Name | Value |
   |------|-------|
   | `VITE_SUPABASE_URL` | your Supabase Project URL |
   | `VITE_SUPABASE_ANON_KEY` | your Supabase anon public key |
   | `RESEND_API_KEY` | your Resend key (`re_...`) |
   | `EMAIL_FROM` | `NCTS PureLight <noreply@thehealedplace.org>` |

   (Until your domain is verified in Resend, set `EMAIL_FROM` to
   `NCTS PureLight <onboarding@resend.dev>`.)
5. Click **Deploy**. When it finishes you get a live URL.

## PART 6 — MAKE YOURSELF THE INSTRUCTOR

1. Open your live Vercel URL → **Create Account** → use YOUR email + a password → submit.
   (If Supabase email confirmation is on, confirm via the email it sends, then sign in.)
2. Back in Supabase → **SQL Editor** → run (replace with your email):
   ```sql
   update pl_profiles set role = 'instructor' where email = 'YOUR_EMAIL';
   ```
3. Sign out and back in. You now see the INSTRUCTOR portal.

## PART 7 — ADD STUDENTS

- Students go to the live URL and **Create Account** themselves (they default to "student").
- Or, from the Instructor → **Students** tab, send an email invite with the signup link.

---

## OPTIONAL — turn off email confirmation (faster signups during setup)
Supabase → **Authentication** → **Providers** → **Email** → toggle off
"Confirm email". (You can turn it back on later.)

## LOCAL TESTING (optional)
1. Copy `.env.example` to `.env` and fill in the four values.
2. `npm install`
3. `npm run dev` → open the printed localhost URL.
   (Email won't work locally — the `/api/send-email` function only runs on Vercel.)
