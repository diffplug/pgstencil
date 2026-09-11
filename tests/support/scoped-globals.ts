import { AsyncLocalStorage } from 'node:async_hooks';
import type { Time, RandomSource } from 'pgstencil';

/** Injected by esbuild into TEST bundles only. Never changes process globals or timers. */
export const deterministicScope = new AsyncLocalStorage<{
  time: Time;
  random: RandomSource;
}>();
const native = globalThis;
const NativeDate = native.Date;
const nativeCrypto = native.crypto;
const now = () =>
  deterministicScope.getStore()?.time.now().getTime() ?? NativeDate.now();
const ScopedDate: DateConstructor = new Proxy(NativeDate, {
  construct(target, args, newTarget) {
    return Reflect.construct(
      target,
      args.length ? args : [now()],
      newTarget === ScopedDate ? target : newTarget,
    );
  },
  apply() {
    return new NativeDate(now()).toString();
  },
  get(target, key, receiver) {
    return key === 'now' ? now : Reflect.get(target, key, receiver);
  },
});
const scopedCrypto = new Proxy(nativeCrypto, {
  get(target, key) {
    if (key === 'getRandomValues')
      return (array: ArrayBufferView) => {
        const random = deterministicScope.getStore()?.random;
        if (!random) return target.getRandomValues(array);
        if (
          !ArrayBuffer.isView(array) ||
          array instanceof DataView ||
          array instanceof Float32Array ||
          array instanceof Float64Array
        )
          throw new TypeError(
            'getRandomValues requires an integer typed array',
          );
        if (array.byteLength > 65536)
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(
          random.bytes(array.byteLength),
        );
        return array;
      };
    if (key === 'randomUUID')
      return () => {
        const random = deterministicScope.getStore()?.random;
        if (!random) return target.randomUUID();
        const bytes = random.bytes(16);
        bytes[6] = (bytes[6]! & 15) | 64;
        bytes[8] = (bytes[8]! & 63) | 128;
        const hex = bytes.toString('hex');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
export {
  ScopedDate as Date,
  scopedCrypto as crypto,
  ScopedDate as 'globalThis.Date',
  scopedCrypto as 'globalThis.crypto',
};
