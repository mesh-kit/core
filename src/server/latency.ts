export class Latency {
  start = 0;
  end = 0;
  ms = 0;
  interval: ReturnType<typeof setTimeout> | undefined;

  onRequest() {
    this.start = Date.now();
  }

  onResponse() {
    this.end = Date.now();
    this.ms = this.end - this.start;
  }
}
