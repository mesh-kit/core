import { type Command } from "../common/message";

export class QueueItem {
  value: Command;
  private expiration: number;

  constructor(value: Command, expiresIn: number) {
    this.value = value;
    this.expiration = Date.now() + expiresIn;
  }

  get expiresIn(): number {
    return this.expiration - Date.now();
  }

  get isExpired(): boolean {
    return Date.now() > this.expiration;
  }
}

export class Queue {
  private items: QueueItem[] = [];

  add(item: Command, expiresIn: number): void {
    this.items.push(new QueueItem(item, expiresIn));
  }

  get isEmpty(): boolean {
    this.items = this.items.filter((item) => !item.isExpired);
    return this.items.length === 0;
  }

  pop(): QueueItem | null {
    while (this.items.length > 0) {
      const item = this.items.shift();
      if (item && !item.isExpired) {
        return item;
      }
    }
    return null;
  }

  clear(): void {
    this.items = [];
  }
}
