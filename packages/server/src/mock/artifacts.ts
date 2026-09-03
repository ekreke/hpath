// Synthetic artifact generation for the mock server.
//
// Screenshots are real PNGs (built with node:zlib), trace.zip is a real zip
// (fflate), and the video is a real, tiny, playable WebM (EBML container
// assembled in code around pre-encoded VP8 keyframes — see makeVideoWebm).

import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import type { Artifact, ArtifactKind, Env, Project, Run } from "@hpath/contract";
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

// ---------------------------------------------------------------------------
// WebM video
// ---------------------------------------------------------------------------

// The three VP8 keyframe payloads of a 160x120 color animation (blue ->
// magenta -> red), pre-encoded once with ffmpeg's libvpx encoder. A VP8
// bool-code encoder is out of scope for the mock; the WebM (Matroska/EBML)
// container below is assembled in code around these payloads, so every run
// gets a tiny but genuinely playable video (T13 replay renders it inline).
const VP8_KEYFRAMES_B64 = [
  "EAcAnQEqoAB4AABHCIWFiJmEiAICAnWqA/gCBpORFXaVCcUtKhOKWlQnFLSoTilpUJxS0qE4paVCcUtKhOKWlKAA/vuwK/+QH/ID/kB//ID//maJjmP16AA=",
  "UAcAnQEqoAB4AABHCIWFiJmEiAICAnWqA/gD+AIGw/BY1ReWvOGk1znDSa5zhpNc5w0muc4aTXOcNJrnOGk1znDR+AD++7Ar/3+q8X8D/3G/+2hnVCX+0AA=",
  "kAYAnQEqoAB4AABHCIWFiJmEiAICAnTyPq1phqi8tecNJrnOGk1znDSa5zhpNc5w0muc4aTXOcNJrnOGbAD++7ArXFzZEUf/mu3//Ndv/+a7f80GAA==",
];
const VIDEO_WIDTH = 160;
const VIDEO_HEIGHT = 120;
const FRAME_INTERVAL_MS = 1000;

/** Raw EBML element: id bytes (with marker bits) + size vint + payload. */
function ebmlElement(id: number[], payload: Uint8Array): Uint8Array {
  // Minimal-length size vint: `len` marker bits in the first byte, then the
  // value in the remaining 7*len bits (all-ones would mean "unknown size").
  let len = 1;
  while (2 ** (7 * len) - 2 < payload.byteLength) len += 1;
  const size = new Array<number>(len);
  for (let i = 0; i < len; i += 1) {
    size[i] = (payload.byteLength >> (7 * (len - 1 - i))) & 0xff;
  }
  size[0] |= 1 << (8 - len);
  const out = new Uint8Array(id.length + len + payload.byteLength);
  out.set(id, 0);
  out.set(size, id.length);
  out.set(payload, id.length + len);
  return out;
}

function ebmlUint(id: number[], value: number): Uint8Array {
  const payload: number[] = [];
  let v = value;
  do {
    payload.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return ebmlElement(id, Uint8Array.from(payload));
}

function ebmlFloat32(id: number[], value: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setFloat32(0, value);
  return ebmlElement(id, payload);
}

function ebmlAscii(id: number[], text: string): Uint8Array {
  const payload = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    payload[i] = text.charCodeAt(i);
  }
  return ebmlElement(id, payload);
}

function ebmlMaster(id: number[], children: Uint8Array[]): Uint8Array {
  const total = children.reduce((sum, child) => sum + child.byteLength, 0);
  const payload = new Uint8Array(total);
  let offset = 0;
  for (const child of children) {
    payload.set(child, offset);
    offset += child.byteLength;
  }
  return ebmlElement(id, payload);
}

/**
 * A tiny real WebM: EBML header + Segment(Info, Tracks, one Cluster) holding
 * the VP8 keyframes above as 1fps keyframes. Every frame is a keyframe, so
 * the stream needs no seek head, cues or lacing to play.
 */
export function makeVideoWebm(): Uint8Array {
  const header = ebmlMaster([0x1a, 0x45, 0xdf, 0xa3], [
    ebmlUint([0x42, 0x86], 1), // EBMLVersion
    ebmlUint([0x42, 0xf7], 1), // EBMLReadVersion
    ebmlUint([0x42, 0xf2], 4), // EBMLMaxIDLength
    ebmlUint([0x42, 0xf3], 8), // EBMLMaxSizeLength
    ebmlAscii([0x42, 0x82], "webm"), // DocType
    ebmlUint([0x42, 0x87], 2), // DocTypeVersion
    ebmlUint([0x42, 0x85], 2), // DocTypeReadVersion
  ]);

  const frames = VP8_KEYFRAMES_B64.map((b64, index) => {
    const payload = Buffer.from(b64, "base64");
    const block = new Uint8Array(4 + payload.byteLength);
    block[0] = 0x81; // track number vint: 1
    block[1] = (index * FRAME_INTERVAL_MS) >> 8; // relative timecode, ms
    block[2] = (index * FRAME_INTERVAL_MS) & 0xff;
    block[3] = 0x80; // flags: keyframe
    block.set(payload, 4);
    return ebmlElement([0xa3], block); // SimpleBlock
  });

  const info = ebmlMaster([0x15, 0x49, 0xa9, 0x66], [
    ebmlUint([0x2a, 0xd7, 0xb1], 1_000_000), // TimecodeScale: 1ms
    ebmlAscii([0x4d, 0x80], "hpath-mock"), // MuxingApp
    ebmlFloat32([0x44, 0x89], VP8_KEYFRAMES_B64.length * FRAME_INTERVAL_MS), // Duration (ms)
    ebmlAscii([0x57, 0x41], "hpath-mock"), // WritingApp
  ]);

  const tracks = ebmlMaster([0x16, 0x54, 0xae, 0x6b], [
    ebmlMaster([0xae], [
      // TrackEntry
      ebmlUint([0xd7], 1), // TrackNumber
      ebmlUint([0x73, 0xc5], 1), // TrackUID
      ebmlUint([0x9c], 0), // FlagLacing
      ebmlUint([0x83], 1), // TrackType: video
      ebmlAscii([0x86], "V_VP8"), // CodecID
      ebmlMaster([0xe0], [
        // Video
        ebmlUint([0xb0], VIDEO_WIDTH), // PixelWidth
        ebmlUint([0xba], VIDEO_HEIGHT), // PixelHeight
      ]),
    ]),
  ]);

  const cluster = ebmlMaster([0x1f, 0x43, 0xb6, 0x75], [
    ebmlUint([0xe7], 0), // Timecode
    ...frames,
  ]);

  const segment = ebmlMaster([0x18, 0x53, 0x80, 0x67], [info, tracks, cluster]);
  const out = new Uint8Array(header.byteLength + segment.byteLength);
  out.set(header, 0);
  out.set(segment, header.byteLength);
  return out;
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
