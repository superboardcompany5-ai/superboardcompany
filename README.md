# SuperBoardCompany

Standalone reel-stock tracker for the SuperBoardCompany customer, extracted from
the InventoryManagement project's reel module (Reel Stock, Reel Receipts, Reel
Dispatches). Fully separate app: own repo, own Supabase project, own Vercel
deployment.

## Setup

1. Create a new Supabase project.
2. Run [supabase/schema.sql](supabase/schema.sql) in the Supabase SQL editor.
3. Create staff accounts in Supabase Auth (Authentication > Users) — there is
   no self sign-up.
4. Copy `.env.example` to `.env` and fill in your project's URL/anon key:
   ```
   VITE_SUPABASE_URL=...
   VITE_SUPABASE_ANON_KEY=...
   ```
5. Install and run:
   ```
   npm install
   npm run dev
   ```

## Deploying

Push this repo to GitHub, then import it into a new Vercel project. Set the
same two `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` env vars in the
Vercel project settings (Production + Preview).
