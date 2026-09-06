import { describe, test, expect } from 'vitest';
import {
  DevTime,
  DevRandom,
  EmailDev,
  decimalCode,
} from '../../packages/pgstencil/src/index.ts';
describe('deterministic application dependencies', () => {
  test('time is isolated and returned dates cannot mutate it', () => {
    const a = new DevTime();
    const b = new DevTime('2030-01-01Z');
    a.now().setUTCFullYear(2099);
    a.advanceHours(23);
    expect(a.now().toISOString()).toBe('2020-01-01T23:00:00.000Z');
    a.advanceHours(1);
    expect(a.now().toISOString()).toBe('2020-01-02T00:00:00.000Z');
    expect(b.now().getUTCFullYear()).toBe(2030);
  });
  test('random streams are isolated and independent of chunk sizes', () => {
    const a = new DevRandom('seed');
    const b = new DevRandom('seed');
    expect(Buffer.concat([a.bytes(1), a.bytes(31), a.bytes(33)])).toEqual(
      b.bytes(65),
    );
    expect(new DevRandom('seed').bytes(16).toString('hex')).toBe(
      '4cc759e57b9ceef815687e1584465c6a',
    );
    expect(decimalCode(new DevRandom())).toMatch(/^\d{8}$/);
  });
  test('mail is captured, copied and consumed per application', async () => {
    const time = new DevTime();
    const mail = new EmailDev(time);
    const other = new EmailDev(time);
    const pending = mail.next();
    const message = {
      from: 'hi@example.test',
      to: ['alice@example.test'],
      subject: 'Sign in',
      html: '<p>Hello</p>',
      text: 'Hello',
    };
    await mail.send(message);
    message.to[0] = 'changed';
    expect((await pending).to).toEqual(['alice@example.test']);
    expect(mail.all()[0]?.capturedAt).toBe('2020-01-01T00:00:00.000Z');
    mail.assertNoUnread();
    expect(other.all()).toEqual([]);
    mail.close();
    other.close();
  });
  test('mail wait uses real time and reports timeout/closure', async () => {
    const mail = new EmailDev(new DevTime());
    await expect(mail.next(5)).rejects.toThrow('Wanted 1 unread emails');
    const pending = mail.next();
    mail.close();
    await expect(pending).rejects.toThrow('closed while waiting');
  });
});
