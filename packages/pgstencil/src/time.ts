export interface Time {
  now(): Date;
}
export class SystemTime implements Time {
  now(): Date {
    return new Date();
  }
}
export class DevTime implements Time {
  private instant = 0;
  constructor(initial: string | Date = '2020-01-01T00:00:00.000Z') {
    this.set(initial);
  }
  now(): Date {
    return new Date(this.instant);
  }
  set(value: string | Date): void {
    const next = new Date(value).getTime();
    if (!Number.isFinite(next)) throw new Error('Invalid time');
    this.instant = next;
  }
  advanceMilliseconds(value: number): void {
    if (!Number.isFinite(value)) throw new Error('Invalid duration');
    this.set(new Date(this.instant + value));
  }
  advanceHours(hours: number): void {
    this.advanceMilliseconds(hours * 3_600_000);
  }
  advanceDays(days: number): void {
    this.advanceHours(days * 24);
  }
}
