# Queues demo

This deployed example proves one application Compute service can both produce
and consume persistent queue messages. Its browser sends messages through the
typed producer dependency. The separate dispatcher claims them from the queue
module's Postgres database and delivers them back to the same application
service's consumer port.

Each queue definition owns its retry policy. This demo uses a fixed five-second
delay and stops after five delivery attempts:

```ts
messages: {
  message: type({ text: 'string' }),
  retry: {
    maxAttempts: 5,
    delay: fixedBackoff({ delay: '5s' }),
  },
}
```

Enable **Fail the first delivery** before enqueuing to exercise the real retry
path. The consumer throws on attempt one. The dispatcher stores the next
availability time in Postgres and delivers the same message again on attempt
two.

The consumed-message panel is a bounded in-memory demo feed. Queue durability
comes from Postgres; refreshing or restarting the application can clear the
display without losing queued messages.
