// Unit tests: the T21 live-view frame hub (broadcast, latest-wins
// backpressure, throttle with trailing flush, close semantics) and its
// per-server registry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RunFrameHub, RunFrameHubRegistry } from "../src/agents/frames.js";

function encoder(bytes: number): Uint8Array {
  return new Uint8Array(bytes).fill(1);
}

test("hub fans frames out to every subscriber in seq order", async () => {
  const hub = new RunFrameHub({ runId: "r1", minIntervalMs: 0 });
  const a = hub.subscribe();
  const b = hub.subscribe();
  assert.equal(hub.subscriberCount, 2);

  const first = hub.publish(encoder(4), "image/jpeg");
  // Both subscribers pick frame 1 up before frame 2 is published.
  const pa = a.next();
  const pb = b.next();
  const second = hub.publish(encoder(8), "image/jpeg");

  assert.equal(first, 1);
  assert.equal(second, 2);
  const a1 = await pa;
  const b1 = await pb;
  assert.equal(a1?.seq, 1);
  assert.equal(b1?.seq, 1);
  assert.deepEqual(a1?.data, encoder(4));
  assert.equal(a1?.mime, "image/jpeg");
  // Both subscribers converge on frame 2.
  const a2 = await a.next();
  const b2 = await b.next();
  assert.equal(a2?.seq, 2);
  assert.equal(b2?.seq, 2);
  assert.deepEqual(b2?.data, encoder(8));
});

test("latest-wins: a slow subscriber skips to the newest frame", async () => {
  const hub = new RunFrameHub({ runId: "r1", minIntervalMs: 0 });
  const sub = hub.subscribe();
  hub.publish(encoder(1));
  hub.publish(encoder(2));
  hub.publish(encoder(3));

  const frame = await sub.next();
  assert.equal(frame?.seq, 3);
  assert.deepEqual(frame?.data, encoder(3));
  // Drained: the next next() only resolves when a new frame (or close) arrives.
  const drained = await Promise.race([
    sub.next().then(() => "resolved"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
  ]);
  assert.equal(drained, "pending");
});

test("throttle drops mid-window frames but flushes the trailing state", async () => {
  let clock = 1_000;
  const hub = new RunFrameHub({ runId: "r1", minIntervalMs: 20, now: () => clock });
  const sub = hub.subscribe();

  assert.equal(hub.publish(encoder(1)), 1);
  assert.equal((await sub.next())?.seq, 1); // drain the accepted frame first
  // Within the window: dropped from the stream, kept as trailing.
  clock += 5;
  assert.equal(hub.publish(encoder(2)), undefined);
  // Replacing the trailing frame keeps only the newest state.
  clock += 5;
  assert.equal(hub.publish(encoder(3)), undefined);

  const trailing = await sub.next(); // parked until the trailing flush fires
  assert.equal(trailing?.seq, 2);
  assert.deepEqual(trailing?.data, encoder(3));

  // After the window elapsed the next frame is accepted immediately.
  clock += 50;
  assert.equal(hub.publish(encoder(4)), 3);
  assert.equal((await sub.next())?.seq, 3);
});

test("close delivers the buffered frame then ends the stream", async () => {
  const hub = new RunFrameHub({ runId: "r1", minIntervalMs: 0 });
  const sub = hub.subscribe();
  hub.publish(encoder(1));
  hub.close();

  const buffered = await sub.next();
  assert.equal(buffered?.seq, 1);
  assert.equal(await sub.next(), undefined);
  assert.equal(hub.publish(encoder(2)), undefined);
});

test("close resolves a waiting next() with undefined", async () => {
  const hub = new RunFrameHub({ runId: "r1", minIntervalMs: 0 });
  const sub = hub.subscribe();
  const pending = sub.next(); // no frame yet: parked
  hub.close();
  assert.equal(await pending, undefined);
});

test("unsubscribe stops delivery and shrinks the fan-out", async () => {
  const hub = new RunFrameHub({ runId: "r1", minIntervalMs: 0 });
  const sub = hub.subscribe();
  assert.equal(hub.subscriberCount, 1);
  sub.unsubscribe();
  assert.equal(hub.subscriberCount, 0);
  hub.publish(encoder(1));
  assert.equal(await sub.next(), undefined);
});

test("onSubscribe fires once per new subscriber", () => {
  const hub = new RunFrameHub({ runId: "r1", minIntervalMs: 0 });
  let calls = 0;
  hub.onSubscribe = () => {
    calls += 1;
  };
  const a = hub.subscribe();
  const b = hub.subscribe();
  a.unsubscribe();
  const c = hub.subscribe();
  assert.equal(calls, 3);
  b.unsubscribe();
  c.unsubscribe();
});

test("a late subscriber only sees frames published after joining", async () => {
  const hub = new RunFrameHub({ runId: "r1", minIntervalMs: 0 });
  hub.publish(encoder(1));
  const late = hub.subscribe();
  hub.publish(encoder(2));
  const frame = await late.next();
  assert.equal(frame?.seq, 2);
});

test("registry create/get/remove; replacing a hub closes the old one", async () => {
  const registry = new RunFrameHubRegistry();
  const first = registry.create("r1", { minIntervalMs: 0 });
  const sub = first.subscribe();
  assert.equal(registry.get("r1"), first);

  const second = registry.create("r1", { minIntervalMs: 0 });
  assert.notEqual(second, first);
  assert.equal(await sub.next(), undefined, "subscribers of a replaced hub end");
  assert.equal(first.publish(encoder(1)), undefined, "a replaced hub is closed");

  registry.remove("r1");
  assert.equal(registry.get("r1"), undefined);
  // remove() only unregisters: the hub object itself keeps working.
  assert.equal(second.publish(encoder(1)), 1);
});
