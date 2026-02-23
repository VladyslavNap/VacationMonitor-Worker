# Scheduler Implementation Summary

## ✅ Implementation Complete

The scheduler functionality has been successfully implemented in the VacationMonitor Worker project. The scheduler runs alongside the job processor, periodically polling Cosmos DB for due searches and enqueuing them to Azure Service Bus.

---

## Files Created

### 1. `src/services/scheduler.service.js`
- Polls Cosmos DB every N minutes (default: 5 minutes)
- Finds searches that are due to run (`schedule.nextRun <= now`)
- Enqueues jobs to Azure Service Bus in batches
- Updates `nextRun` and `lastRunAt` timestamps
- Handles errors gracefully with consecutive error tracking
- Automatic shutdown after 10 consecutive failures

### 2. `src/services/distributed-lock.service.js`  
- Implements distributed locking using Cosmos DB
- Ensures only one Worker instance runs the scheduler (multi-instance safe)
- Lock auto-renewal every 30 seconds
- Lock expiration after 90 seconds
- Optimistic concurrency control with ETag

---

## Files Modified

### 1. `src/workers/price-monitor.worker.js`
**Changes:**
- Imported `schedulerService`
- Added scheduler startup in `start()` method (with error handling)
- Added scheduler shutdown in `stop()` method
- Improved graceful shutdown with 30-second timeout
- Enhanced startup banner to show "Job Processor + Scheduler"

### 2. `.env.example`
**Added variables:**
```bash
SCHEDULER_ENABLED=true               # Set to 'false' to disable
SCHEDULER_INTERVAL_MINUTES=5         # Polling interval
```

---

## Files Already Present (No Changes Needed)

### `src/services/cosmos-db.service.js`
✅ Already contains `getDueSearches()` method at line ~250

### `src/services/job-queue.service.js`
✅ Already contains `enqueueBatch()` method

---

## How It Works

### Multi-Instance Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Worker A      │     │   Worker B      │     │   Worker C      │
│                 │     │                 │     │                 │
│  Job Processor  │     │  Job Processor  │     │  Job Processor  │
│    (Active)     │     │    (Active)     │     │    (Active)     │
│                 │     │                 │     │                 │
│   Scheduler ✅  │     │   Scheduler ⏸️  │     │   Scheduler ⏸️  │
│  (Has Lock)     │     │  (No Lock)      │     │  (No Lock)      │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────────────┴───────────────────────┘
                                 │
                   ┌─────────────▼──────────────┐
                   │     Cosmos DB              │
                   │  ┌──────────────────────┐  │
                   │  │ Distributed Lock     │  │
                   │  │ lockName: "sched…"   │  │
                   │  │ instanceId: "abc123" │  │
                   │  │ expiresAt: "2026…"   │  │
                   │  └──────────────────────┘  │
                   │                            │
                   │  Searches, Prices, etc.    │
                   └────────────────────────────┘
                                 │
                   ┌─────────────▼──────────────┐
                   │   Azure Service Bus        │
                   │   Queue: price-monitor-jobs│
                   └────────────────────────────┘
```

**How it works:**
1. All Worker instances run both job processor and scheduler code
2. Only the instance holding the distributed lock actually executes scheduler ticks
3. Other instances skip scheduler ticks but continue processing jobs
4. If lock holder crashes, another instance automatically takes over (lock expires after 90s)
5. Lock is renewed every 30 seconds by the holder

---

## Environment Variables

### Required (Existing)
```bash
COSMOS_ENDPOINT=https://your-cosmos-account.documents.azure.com:443/
COSMOS_KEY=your-cosmos-key
COSMOS_DATABASE_NAME=your-database-name
AZURE_SERVICE_BUS_CONNECTION_STRING=Endpoint=sb://...
AZURE_SERVICE_BUS_QUEUE_NAME=price-monitor-jobs
```

### Optional (New)
```bash
SCHEDULER_ENABLED=true               # Set to 'false' to disable scheduler entirely
SCHEDULER_INTERVAL_MINUTES=5         # How often to poll for due searches (default: 5)
```

---

## Testing

### Local Testing
```bash
# Start worker with scheduler (default)
npm start

# Start worker with faster scheduler polling (1 minute)
SCHEDULER_INTERVAL_MINUTES=1 npm start

# Start worker with scheduler disabled
SCHEDULER_ENABLED=false npm start
```

### Expected Logs
```
============================================================
VacationMonitor Worker — Job Processor + Scheduler
Environment: development
============================================================
Initializing Cosmos DB connection for scheduler...
Initializing Service Bus connection for scheduler...
Initializing distributed lock for multi-instance support...
✅ Price Monitor Worker started and listening for jobs
Scheduler tick: checking for due searches...
Found due searches { count: 3 }
Scheduler tick completed { enqueued: 3, updated: 3, durationMs: 1234 }
✅ Scheduler started successfully
```

### Multi-Instance Testing
Deploy 2+ Worker instances and verify:
- Only one shows "Found due searches"
- Others show "Another instance holds the scheduler lock, skipping this tick"

---

## Monitoring

### Health Check (Optional)
Add a health endpoint to expose scheduler status:

```javascript
import schedulerService from './services/scheduler.service.js';

// In your health endpoint:
const status = schedulerService.getStatus();
// Returns:
// {
//   isRunning: true,
//   lastTickTime: "2026-02-23T10:05:00.000Z",
//   consecutiveErrors: 0,
//   maxConsecutiveErrors: 10,
//   pollIntervalMinutes: 5,
//   isDisabled: false,
//   distributedLock: {
//     instanceId: "abc123xyz",
//     isLocked: true
//   }
// }
```

### Azure Application Insights
Track custom metrics:
- Scheduler tick duration
- Number of due searches found per tick
- Consecutive errors
- Lock acquisition success/failure

---

## Troubleshooting

### Scheduler Not Starting
**Symptom:** Logs show "Scheduler is disabled"

**Fix:** Check `SCHEDULER_ENABLED` environment variable is not set to `'false'`

### Multiple Instances Running Scheduler
**Symptom:** Duplicate jobs being enqueued

**Fix:**
- Verify `distributed-lock.service.js` is working correctly
- Check Cosmos DB connection is shared across instances
- Ensure `lockDurationSeconds` (90s) is longer than `pollIntervalMs`
- Check Cosmos DB `locks` container exists and is accessible

### Scheduler Stops After Errors
**Symptom:** Scheduler stops automatically

**Fix:**
- Check logs for root cause (usually Cosmos DB or Service Bus connectivity)
- Review error counter (stops after 10 consecutive failures)
- Restart Worker to reset error counter

### Lock Contention
**Symptom:** Frequent "Another instance holds the scheduler lock" messages

**Expected behavior:** This is normal in multi-instance deployments. Only the lock holder runs the scheduler.

---

## Next Steps

### Remove Scheduler from Web Project
Now that the Worker has the scheduler, you can remove it from the Web project:

1. Delete `src/services/scheduler.service.js` from Web
2. Delete `src/services/distributed-lock.service.js` from Web
3. Remove scheduler startup from Web's entry point
4. Remove `SCHEDULER_*` environment variables from Web
5. Update Web's documentation

### Deploy Worker with Scheduler
1. Set environment variables in Azure Portal or deployment config
2. Deploy Worker to Azure App Service or Container Apps
3. Use at least 2 instances for high availability
4. Monitor logs to verify scheduler is running

---

## Summary

✅ Scheduler service created  
✅ Distributed lock service created  
✅ Worker integrated with scheduler  
✅ Graceful shutdown implemented  
✅ Environment variables documented  
✅ Multi-instance support via distributed locking  
✅ Error handling with automatic shutdown  
✅ `getDueSearches()` method already present in Cosmos DB service  

**The Worker now runs both job processing and scheduling in a single, scalable process.**
