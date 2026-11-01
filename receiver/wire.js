// Request parts (contract C4). The daemon is the real sender; splitParts is here
// for tests and the shared vector.

export const PART_BYTES = 700000;

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function splitParts(id, request, partBytes = PART_BYTES) {
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  const n = Math.max(1, Math.ceil(bytes.length / partBytes));
  const parts = [];
  for (let seq = 0; seq < n; seq++) {
    const slice = bytes.subarray(seq * partBytes, (seq + 1) * partBytes);
    parts.push({ t: "part", id, seq, n, b64: toBase64(slice) });
  }
  return parts;
}

export class PartJoiner {
  #id = null;
  #n = 0;
  #slices = new Map();

  #drop() {
    this.#id = null;
    this.#n = 0;
    this.#slices = new Map();
  }

  // Returns the parsed request when the last part of an id arrives, else null.
  push(part) {
    if (!part || typeof part.id !== "string") return null;
    if (part.id !== this.#id) {
      this.#drop();
      this.#id = part.id;
      this.#n = part.n;
    }
    const { seq, n, b64 } = part;
    if (!Number.isInteger(n) || n < 1 || n !== this.#n || !Number.isInteger(seq) || seq < 0 || seq >= n || typeof b64 !== "string") {
      this.#drop();
      return null;
    }
    let slice;
    try {
      const bin = atob(b64);
      slice = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) slice[i] = bin.charCodeAt(i);
    } catch {
      this.#drop();
      return null;
    }
    this.#slices.set(seq, slice);
    if (this.#slices.size < n) return null;
    const total = [...this.#slices.values()].reduce((a, s) => a + s.length, 0);
    const all = new Uint8Array(total);
    let at = 0;
    for (let i = 0; i < n; i++) {
      all.set(this.#slices.get(i), at);
      at += this.#slices.get(i).length;
    }
    this.#drop();
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
    } catch {
      return null;
    }
  }
}
