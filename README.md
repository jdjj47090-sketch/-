# CYBR-MAHI Burner Fleet Engine

## Deployment Steps
1. Initialize repository: `git init`
2. Add files: `package.json`, `.github/workflows/deploy.yml`, and `server.js`
3. Push to GitHub main branch.
4. Run locally via Node.js:
   ```bash
   npm install
   npx playwright install chromium
   npm start
