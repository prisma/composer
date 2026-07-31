export interface QueueConsumerMessage<Body> {
  readonly id: string;
  readonly queue: string;
  readonly body: Body;
  readonly attempt: number;
  readonly enqueuedAt: string;
}
