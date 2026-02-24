# Tesser API Demo

E2E demo and integration reference for the Tesser stablecoin payments API.

## Setup

1. Install dependencies:

   ```bash
   bun install
   ```

2. Copy the environment template and fill in your credentials:

   ```bash
   cp .env.example .env.local
   ```

   Edit `.env.local` with your Tesser sandbox credentials:

   - `TESSER_CLIENT_ID` — your API client ID
   - `TESSER_CLIENT_SECRET` — your API client secret

3. Run the demo:

   ```bash
   bun run index.ts
   ```

## CI / Cross-repo trigger

The E2E workflow (`.github/workflows/e2e.yml`) runs automatically when `tesser-payments/platform` merges to main, and can also be triggered manually from the Actions tab.

**Triggers:**

- `repository_dispatch` — fired by the platform repo after a deploy to main
- `workflow_dispatch` — manual trigger from the GitHub Actions tab

### Secrets to configure in this repo (`api-demo`)

| Secret | Description |
|--------|-------------|
| `TESSER_CLIENT_ID` | Tesser sandbox API client ID |
| `TESSER_CLIENT_SECRET` | Tesser sandbox API client secret |
| `TESSER_BASE_URL` | Tesser sandbox base URL (e.g. `https://sandbox.tesserx.co`) |
| `TESSER_AUTH_URL` | Auth token endpoint URL |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL for failure notifications |

### Platform repo setup (`tesser-payments/platform`)

1. Create a **fine-grained GitHub PAT** scoped to `tesser-payments/api-demo` with **Contents: Read and write** permission
2. Add it as the `API_DEMO_PAT` secret in `tesser-payments/platform`
3. Create `.github/workflows/trigger-e2e.yml` in the platform repo:

   ```yaml
   name: Trigger API Demo E2E

   on:
     push:
       branches: [main]

   jobs:
     trigger:
       runs-on: ubuntu-latest
       steps:
         - name: Dispatch to api-demo
           uses: peter-evans/repository-dispatch@v3
           with:
             token: ${{ secrets.API_DEMO_PAT }}
             repository: tesser-payments/api-demo
             event-type: platform-deploy
   ```
