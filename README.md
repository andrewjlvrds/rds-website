# RDS Website

Tour pricing API and booking form for [Ride Down South](https://ridedownsouth.com).

## What this does

- **`/api/tour-prices`** — Returns tour pricing data from Google Sheets (for WordPress embed)
- **`/api/tour-availability`** — Returns available tours and departure dates (for booking form)
- **`/api/submit-booking`** — Submits booking to Zoho CRM (coming soon)
- **WordPress embed** — `embeds/tour-prices-embed.html` replaces SheetDB shortcodes on the Dates & Prices page

## Setup

### Environment Variables (Vercel)

| Variable | Purpose |
|----------|---------|
| `GOOGLE_SHEETS_API_KEY` | Read tour data from Google Sheets |
| `ZOHO_CLIENT_ID` | Zoho CRM OAuth |
| `ZOHO_CLIENT_SECRET` | Zoho CRM OAuth |
| `ZOHO_REFRESH_TOKEN` | Zoho CRM OAuth refresh token flow |

### Deploy

1. Push to GitHub
2. Connect repo to Vercel
3. Set environment variables in Vercel dashboard
4. Deploy

### WordPress Embed

1. Copy contents of `embeds/tour-prices-embed.html`
2. Paste into a WordPress HTML block on the Dates & Prices page
3. Update `API_URL` in the script if your Vercel domain differs from `rds-website.vercel.app`
4. Remove old SheetDB shortcodes
5. Disable SheetDB plugin

## Code Style

ES5 JavaScript throughout — consistent with the RDS Crew Portal codebase.

## Data Source

Google Sheet: `1LcmK8TPLT32XJL6APJQPjR5JLSKmxuBsLVuDHgfAckQ`
<!-- cache bust 2026-05-18T08:36:01Z -->
