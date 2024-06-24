// mock_stream.ts
export class MockStream {
  private events: any[];

  constructor(events: any[]) {
    this.events = events;
  }

  async *[Symbol.asyncIterator]() {
    for (const event of this.events) {
      yield event;
      await new Promise((resolve) => setTimeout(resolve, 10)); // Simulate delay
    }
  }
}
