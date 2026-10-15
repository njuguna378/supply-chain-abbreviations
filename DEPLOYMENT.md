# Vercel deployment

The dictionary is stored in `data/abbreviations.xlsx` in the connected GitHub repository. Its `Acronyms` worksheet has columns for acronym, full definition, and meaning. Its `Suggestions` worksheet is the private moderation queue. Vercel API functions use a GitHub token server-side to read and commit changes to the workbook; the browser never receives that token.

## One-time setup

1. Create a private GitHub repository and connect it to Vercel. Push this project, including `package.json`, the `api` directory, and `data/abbreviations.xlsx`.
2. Create a fine-grained GitHub token restricted to that repository, with **Contents: Read and write** permission. Add it to Vercel as `GITHUB_TOKEN`.
3. In Firebase Authentication, keep Google sign-in enabled. Add `FIREBASE_PROJECT_ID=insupply-abbreviations` to Vercel. The API verifies Firebase ID tokens against Google's public signing keys; no service-account key is needed.
4. Add `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`, `WORKBOOK_PATH`, and `ADMIN_EMAIL` from `.env.example` to Vercel. Set the branch to the branch Vercel deploys and `ADMIN_EMAIL` to the verified admin Google account.
5. Redeploy the Vercel project. Enable rate limiting for `POST /api/suggestions` in Vercel Firewall so the public suggestion form cannot be used to generate excessive commits.

For local development, copy `.env.example` to `.env.local`, fill in the values, install packages with `npm install`, then run `npx vercel dev`. Never commit `.env.local` or GitHub tokens.

The generated `styles.css` is committed so Vercel can serve production-ready CSS without the Tailwind CDN. If you edit `index.html` utility classes or `styles.input.css`, regenerate and commit the stylesheet with `npm run build:css`.

To create a blank workbook before the first deploy, run `npm run create-template`. The script does not overwrite an existing workbook. Export the current Firestore dictionary to an Excel file and import it through the admin UI before directing users to the new app; this app does not automatically migrate Firestore data.

## Access model

- Anyone can read the published dictionary and submit a suggestion.
- Suggestions are saved in the workbook but only the verified admin can read or review them.
- All workbook edits, imports, approvals, and deletes require a verified Firebase Google sign-in matching `ADMIN_EMAIL`; the Vercel API verifies the ID token server-side.
- The GitHub write token must only exist in Vercel server-side environment variables. Firebase project ID is not a secret.
