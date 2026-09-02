// Synthetic artifact generation for the mock server.
//
// Screenshots are real PNGs (built with node:zlib), trace.zip is a real zip
// (fflate), and the video is an EBML-magic placeholder — a playable sample
// video can replace it in T13 if needed.

import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import type { Artifact, ArtifactKind, Env, Project, Run } from "../gen/hpath/v1/hpath.js";
import type { MockStore } from "./store.js";
import { nowIso } from "./store.js";

// ---------------------------------------------------------------------------
// CRC32 + PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode a solid-color truecolor PNG. */
export function makePng(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const rowSize = 1 + width * 3;
  const raw = new Uint8Array(rowSize * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * rowSize;
    raw[offset] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const p = offset + 1 + x * 3;
      raw[p] = rgb[0];
      raw[p + 1] = rgb[1];
      raw[p + 2] = rgb[2];
    }
  }
  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw))),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trace zip / video placeholder / request log
// ---------------------------------------------------------------------------

/** Real zip archive containing a placeholder Chrome-style trace document. */
export function makeTraceZip(runId: string): Uint8Array {
  const trace = {
    traceEvents: [
      {
        cat: "hpath",
        name: "mock-trace",
        ph: "M",
        ts: 0,
        pid: 1,
        tid: 1,
        args: { runId, note: "synthetic trace produced by the mock server" },
      },
    ],
  };
  return zipSync({ "trace.stripped.json": strToU8(JSON.stringify(trace, null, 2)) });
}

// Placeholder bytes starting with the EBML magic (0x1A45DFA3). Not a playable
// video; replaced by a real fixture when desktop playback lands (T13).
export function makeVideoPlaceholder(): Uint8Array {
  const bytes = new Uint8Array(1024);
  bytes[0] = 0x1a;
  bytes[1] = 0x45;
  bytes[2] = 0xdf;
  bytes[3] = 0xa3;
  const marker = "hpath mock video placeholder";
  for (let i = 0; i < marker.length; i += 1) {
    bytes[16 + i] = marker.charCodeAt(i);
  }
  return bytes;
}

export function makeRequestLog(runId: string, exchanges: unknown[]): Uint8Array {
  return strToU8(JSON.stringify({ runId, exchanges }, null, 2));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function registerArtifact(
  store: MockStore,
  run: Run,
  project: Project,
  env: Env,
  kind: ArtifactKind,
  filename: string,
  data: Uint8Array,
): Artifact {
  const id = randomUUID();
  const artifact: Artifact = {
    id,
    runId: run.id,
    kind,
    key: `artifacts/${project.id}/${env.id}/${run.id}/${filename}`,
    sizeBytes: data.byteLength,
    sha256: sha256Hex(data),
    createdAt: nowIso(),
  };
  store.artifacts.set(id, artifact);
  store.artifactData.set(id, data);
  return artifact;
}
