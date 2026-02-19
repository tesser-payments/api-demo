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
