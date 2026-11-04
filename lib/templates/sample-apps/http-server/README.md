# Basic HTTP Server

This example starts one HTTP server managed by ZM2/systemd.
The ecosystem configuration uses `instances: 1`; other requested counts
are accepted for compatibility but ignored with a warning.

## Via CLI

```bash
zm2 start api.js
```

ZM2 does not provide cluster workers, shared HTTP listeners or automatic load balancing.
