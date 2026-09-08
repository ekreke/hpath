// Shared gRPC client helpers for the smoke and demo scripts: a constructor
// wrapper over the generated HpathService, thin unary/stream wrappers, an
// error-probing unary, and the assert helper both scripts print with.

import { credentials, makeClientConstructor, status } from "@grpc/grpc-js";
import type { ChannelCredentials } from "@grpc/grpc-js";
import { HpathService } from "@hpath/contract";
import type {
  HpathServer,
} from "@hpath/contract";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HpathClient = any;

export const HPATH_ADDR = process.env.HPATH_ADDR ?? "127.0.0.1:50051";

export const client = new (makeClientConstructor(HpathService as never, "HpathService") as unknown as {
  new (address: string, credentials: ChannelCredentials): HpathClient;
})(HPATH_ADDR, credentials.createInsecure()) as HpathClient;

export function unary<Req, Res>(method: keyof HpathServer, request: Req): Promise<Res> {
  return new Promise((resolve, reject) => {
    (client as Record<string, (req: Req, cb: (err: unknown, res: Res) => void) => void>)[
      method as string
    ](request, (err: unknown, res: Res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

export function stream<Req, Res>(method: keyof HpathServer, request: Req): Promise<Res[]> {
  return new Promise((resolve, reject) => {
    const chunks: Res[] = [];
    const call = (
      client as unknown as Record<string, (req: Req) => {
        on(ev: "data", cb: (chunk: Res) => void): void;
        on(ev: "end" | "error", cb: (err?: unknown) => void): void;
      }>
    )[method as string](request);
    call.on("data", (chunk: Res) => chunks.push(chunk));
    call.on("end", () => resolve(chunks));
    call.on("error", (err: unknown) => reject(err));
  });
}

export function unaryError<Req>(method: keyof HpathServer, request: Req): Promise<{ code: number; details: string }> {
  return new Promise((resolve, reject) => {
    (client as Record<string, (req: Req, cb: (err: unknown, res: unknown) => void) => void>)[
      method as string
    ](request, (err: unknown) => {
      if (err) resolve(err as { code: number; details: string });
      else reject(new Error(`expected ${String(method)} to fail`));
    });
  });
}

export function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`DEMO FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`  ok: ${message}`);
}

export { status };
