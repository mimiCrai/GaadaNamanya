// KafkaJS default heartbeatInterval is 3 s; heartbeat() itself throttles, so a 1 s tick is cheap
export const HEARTBEAT_TICK_MS = 1_000;

// periodic group heartbeat while a batch runs, so a long successful flush/snapshot never outlives the session timeout
export function keepAlive(heartbeat: () => Promise<void>, intervalMs = HEARTBEAT_TICK_MS): () => void {
    let inFlight = false;
    const timer = setInterval(() => {
        if (inFlight) return;
        inFlight = true;
        heartbeat()
            .catch(() => undefined)
            .finally(() => (inFlight = false));
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}
