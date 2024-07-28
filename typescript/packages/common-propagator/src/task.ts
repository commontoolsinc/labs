export interface AnyTask {
  poll(): void;
}

export const task = (poll: () => void) => ({ poll });

export default task;
