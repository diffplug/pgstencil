import { createHash, randomBytes } from 'node:crypto';
export interface RandomSource {
  bytes(length: number): Buffer;
}
function validLength(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0 || n > 1_048_576)
    throw new Error('Invalid random byte length');
}
export class SecureRandom implements RandomSource {
  bytes(length: number): Buffer {
    validLength(length);
    return randomBytes(length);
  }
}
/** Test-only SHA-256 seed/counter stream. Never use for production secrets. */
export class DevRandom implements RandomSource {
  private counter = 0n;
  private pending = Buffer.alloc(0);
  constructor(private readonly seed = 'pgstencil') {}
  bytes(length: number): Buffer {
    validLength(length);
    if (this.pending.length < length) {
      // Grow in one concat: appending per block would recopy the whole buffer.
      const blocks = [this.pending];
      let total = this.pending.length;
      while (total < length) {
        const counter = Buffer.alloc(8);
        counter.writeBigUInt64BE(this.counter++);
        const block = createHash('sha256')
          .update('pgstencil-dev-random-v1\0')
          .update(this.seed)
          .update('\0')
          .update(counter)
          .digest();
        blocks.push(block);
        total += block.length;
      }
      this.pending = Buffer.concat(blocks, total);
    }
    const result = Buffer.from(this.pending.subarray(0, length));
    this.pending = this.pending.subarray(length);
    return result;
  }
}
export function token(random: RandomSource, length = 32): string {
  return random.bytes(length).toString('base64url');
}
/** Rejection sampling keeps every decimal digit equally likely. */
export function decimalCode(random: RandomSource, length = 8): string {
  let result = '';
  while (result.length < length) {
    const value = random.bytes(1)[0]!;
    if (value < 250) result += String(value % 10);
  }
  return result;
}
