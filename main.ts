// main.ts — the entrypoint lifecycle the harness drives.
//
// The contract, in order:
//   1. MAKEFUN_ENV_URL names the env (suite) origin. Without it there is
//      nothing to talk to, so the program exits 1 at once.
//   2. The server comes from app.ts's createApp() and listens on port 0,
//      so the kernel picks a free ephemeral port. Port 8080 belongs to
//      the env and is never bound here.
//   3. The bound port is announced with one POST to <env>/register
//      carrying the JSON body {"port": <port>}. The env may still be
//      booting when we come up, so a failed request or a server-error
//      answer is retried with short exponential backoff; the first
//      register is the one that fixes our base URL on the env side.
//   4. GET <env>/done is polled until it answers {"done": true}. While
//      the suite runs it answers {"done": false}. A failed poll is
//      retried with backoff and is never fatal.
//   5. Once done, the server closes and the program exits 0.

import { createApp } from "./app.ts";
import type { Server } from "node:http";

const envUrl = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");

if (envUrl === "") {
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One backoff step: double the current delay, never past the cap.
function nextDelay(current: number, cap: number): number {
  return Math.min(current * 2, cap);
}

async function register(port: number): Promise<void> {
  let delay = 100;
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
      });
      if (res.status < 500) {
        // The env heard us: a success the first time, and any later
        // answer (including a 409) leaves the registered port standing.
        await res.arrayBuffer().catch(() => undefined);
        return;
      }
    } catch {
      // A network-level failure just means the env is not up yet.
    }
    await sleep(delay);
    delay = nextDelay(delay, 1000);
  }
}

async function waitUntilDone(): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/done`);
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) {
          return;
        }
        // A clean "not yet" answer: restart the backoff from the floor.
        delay = 250;
      } else {
        // Drain an error answer so its socket is released for reuse.
        await res.arrayBuffer().catch(() => undefined);
      }
    } catch {
      // Poll failures are expected while the env works; never fatal.
    }
    await sleep(delay);
    delay = nextDelay(delay, 2000);
  }
}

async function main(): Promise<void> {
  const server: Server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server did not bind a TCP port");
  }
  await register(address.port);
  await waitUntilDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

main().catch(() => {
  process.exit(1);
});
