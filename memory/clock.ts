class Clock {
  /**
   * Accurracy in seconds, e.g. if you set `10` clock will work
   * in `10` second accuracy and round down time.
   */
  constructor(public accuracy: number = 1) {
  }
  now() {
    return ((Date.now() / (1000 * this.accuracy)) | 0) * this.accuracy;
  }

  /**
   * Creates a clock with a differenc accuracy.
   */
  with(accuracy: number) {
    return new Clock(accuracy);
  }
}

export default new Clock();
