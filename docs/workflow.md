# n8n Workflow (MVP)

## Nodes (happy path)
1. **Webhook (POST /foldy/run)**
2. **Function: validate + normalize URL**
3. **Set: devices = [iphone_15_pro, iphone_15_pro_max, pixel_8, galaxy_s23, iphone_se_2]**
4. **Split In Batches (1) + Loop over devices**
   - **HTTP Request → /render** (Auth: Bearer RENDER_TOKEN)
   - **Wait (if needed)**; **Error Trigger** path to retry once
5. **Merge (Wait for All)** → collect 5 payloads
6. **Function: scoring + aggregate overall**
7. **Supabase: Insert `pages` (on conflict do nothing)**
8. **Supabase: Insert `runs`** (overall score)
9. **Supabase: Insert `run_devices`** (5 rows)
10. **Respond to Webhook** with `{ run_id, results }`

## Env
- SUPABASE_URL, SUPABASE_SERVICE_KEY
- RENDER_URL, RENDER_TOKEN

## Concurrency & retries
- Max 5 in parallel (one per device).
- Retry /render once on 5xx with 2s backoff.
- Timeouts: 25s per device request.

## Outputs
- `run_id`
- Array of per-device summaries for the UI.
