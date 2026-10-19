export function tari(micro: bigint | number | string): string {
  const v = BigInt(micro);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function toMicro(text: string): bigint {
  const [w, f = ""] = text.trim().split(".");
  return BigInt(w || "0") * 1_000_000n + BigInt((f + "000000").slice(0, 6));
}

export function short(id: string, head = 10, tail = 6): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}
