export class IdManager {
  private usedIds: Set<number> = new Set();
  private counter: number = 0;
  private maxCounter: number;

  constructor(maxCounter: number = 9999) {
    this.maxCounter = maxCounter;
  }

  release(id: number) {
    this.usedIds.delete(id);
  }

  reserve(): number {
    this.counter = (this.counter + 1) % this.maxCounter;
    const timestamp = Date.now() % 10000;
    let id = timestamp * 10000 + this.counter;

    while (this.usedIds.has(id)) {
      id = (id + 1) % (10000 * 10000);
    }

    this.usedIds.add(id);
    return id;
  }
}
