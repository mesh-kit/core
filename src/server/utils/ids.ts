import { getRandomValues } from "node:crypto";

const HEX: string[] = [];

for (let i = 0; i < 256; i++) {
  HEX[i] = (i + 256).toString(16).substring(1);
}

function pad(str: string, size: number) {
  const s = `000000${str}`;
  return s.substring(s.length - size);
}

const SHARD_COUNT = 32;

export function getCreateId(opts: { init: number; len: number }) {
  const len = opts.len || 16;
  let str = "";
  let num = 0;
  const discreteValues = 1_679_616; // Math.pow(36, 4)
  let current = opts.init + Math.ceil(discreteValues / 2);

  function counter() {
    if (current >= discreteValues) current = 0;
    current++;
    return (current - 1).toString(16);
  }

  return () => {
    if (!str || num === 256) {
      const bytes = new Uint8Array(len);
      getRandomValues(bytes);
      str = Array.from(bytes, (b) => HEX[b])
        .join("")
        .substring(0, len);
      num = 0;
    }

    const date = Date.now().toString(36);
    const paddedCounter = pad(counter(), 6);
    const hex = HEX[num++]!;

    const shardKey = parseInt(hex, 16) % SHARD_COUNT;

    return `conn-${date}${paddedCounter}${hex}${str}${shardKey}`;
  };
}
