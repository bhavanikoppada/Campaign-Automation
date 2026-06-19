# N8N Workflow Changes Required

## Why your flows were conflicting

The "Run Trigger" (Schedule Trigger / Manual Trigger) in N8N has a concurrency constraint:
N8N queues multiple executions of the **same** workflow rather than running them in true parallel.
Multiple **different** workflows running at the same time can also hit the same worker process and
error on resource contention.

**Fix:** Replace the trigger node in every campaign workflow with a **Webhook** node.
Your orchestrator server calls all webhook URLs simultaneously — N8N handles each as an
independent HTTP request, so they run in true parallel.

---

## Step 1 — Change each workflow's trigger

1. Open the campaign workflow in N8N
2. **Delete** the existing trigger node (Schedule Trigger / Manual Trigger)
3. Add a **Webhook** node as the new start
4. Set Method: `POST`
5. Copy the **Webhook URL** shown — you'll use this in your orchestrator request
6. In "Response Mode" choose **"Respond Immediately"** (don't wait for the workflow to finish)
7. **Save and Activate** the workflow

> The incoming POST body will contain `{ campaignId, batchId, ...your payload }` automatically
> injected by the orchestrator.

---

## Step 2 — Read incoming data in your workflow

After the Webhook node, use a **Set** node or reference `{{ $json.body }}` directly:

```
{{ $json.body.campaignId }}   ← campaign ID
{{ $json.body.batchId }}      ← batch ID for callback
{{ $json.body.recipientList }} ← or whatever payload you send
```

---

## Step 3 — Report back when done (optional but recommended)

Add an **HTTP Request** node at the very end of your workflow to report completion:

| Field  | Value |
|--------|-------|
| Method | POST  |
| URL    | `https://your-orchestrator.onrender.com/callback/{{ $json.body.batchId }}/{{ $json.body.campaignId }}` |
| Body (JSON) | `{ "status": "done", "emailsSent": {{ $node["Send Email"].json.count }} }` |

This triggers a `campaign_finished` WebSocket event on your client.

---

## Step 4 — (Optional) Enable N8N Queue Mode for high volume

If you're running many campaigns with thousands of recipients, enable N8N's built-in queue mode
so workflows execute across multiple worker processes:

In your N8N `.env`:
```
EXECUTIONS_MODE=queue
QUEUE_BULL_REDIS_HOST=your-redis-host
QUEUE_BULL_REDIS_PORT=6379
```

Then start additional workers:
```bash
n8n worker
```

This is only needed if individual workflows are slow/heavy. For typical email/webpush campaigns
the webhook approach alone is sufficient.

---

## How to call the orchestrator

```js
// Trigger 3 campaigns at the same time
const response = await fetch('https://your-orchestrator.onrender.com/trigger-campaigns', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    campaigns: [
      {
        id: 'email-june-promo',
        webhookUrl: 'https://your-n8n.com/webhook/abc123',
        payload: { recipientList: 'segment-a', subject: 'June Promo' }
      },
      {
        id: 'webpush-flash-sale',
        webhookUrl: 'https://your-n8n.com/webhook/def456',
        payload: { title: 'Flash Sale', body: '50% off today!' }
      },
      {
        id: 'email-reminder',
        webhookUrl: 'https://your-n8n.com/webhook/ghi789',
        payload: { template: 'reminder-v2' }
      }
    ]
  })
});

const { batchId } = await response.json();
// Now connect WebSocket to track live status
const ws = new WebSocket('wss://your-orchestrator.onrender.com');
ws.onmessage = (e) => {
  const event = JSON.parse(e.data);
  if (event.batchId === batchId) {
    console.log(event.type, event); // campaign_triggering, campaign_triggered, batch_complete, etc.
  }
};
```

## WebSocket events reference

| Event | When |
|-------|------|
| `connected` | Client connects |
| `batch_started` | Orchestrator begins firing all webhooks |
| `campaign_triggering` | About to call a specific webhook |
| `campaign_triggered` | N8N webhook responded OK |
| `campaign_error` | Webhook call failed (bad URL, timeout, N8N error) |
| `campaign_finished` | N8N workflow completed and called /callback |
| `batch_complete` | All webhooks have responded (success or error) |
