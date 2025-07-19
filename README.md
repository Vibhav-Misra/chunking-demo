# Overview

On the client side, we capture your webcam via the browser’s MediaRecorder API, emit 1 s video blobs, then slice each blob into 256 KB ArrayBuffers and send them over a secure WebSocket (`wss://…`). On the server side (Node.js), we buffer incoming frames in memory until we hit a 6 MB threshold, then flush that chunk as one part of an S3 multipart upload. Once you click “Stop,” we flush any remaining bytes (even if under 5 MB), complete the multipart upload (or do a single-object PUT if you never crossed 5 MB), and respond back to the client with a “completed” message and file URL.

## Production‐readiness

- **Config & Secrets**: Move hard‑coded values (`REGION`, `BUCKET`, `WS_URL`, `PORT`) into env vars or a secrets store so you can swap buckets, endpoints, or regions without code changes.

- **Security**: Terminate TLS at your load‑balancer or API Gateway so you use `wss://`, and protect your S3 credentials via IAM roles (or an equivalent vault).

- **Scaling & State**: If you run multiple server replicas, either enable session affinity (sticky sessions) on your WebSocket layer or externalize the multipart state (buffers, part counts, upload IDs) into Redis or a durable cache.

- **Observability**: Emit structured logs and metrics (bytes sent, parts uploaded, errors) to your monitoring system (CloudWatch, Datadog, etc.) and set up alerts on error rates or latency spikes.



<img width="1565" height="613" alt="image" src="https://github.com/user-attachments/assets/7d007bec-6977-4a20-a78f-94b6a71874e6" />




<img width="1550" height="729" alt="image" src="https://github.com/user-attachments/assets/96f6dda8-4c81-45e5-8155-5c7b85ee94d7" />


