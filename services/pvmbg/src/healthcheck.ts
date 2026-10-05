const port = process.env.PORT ?? '8082';

fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3_000) })
    .then((response) => process.exit(response.ok ? 0 : 1))
    .catch(() => process.exit(1));

export {};
