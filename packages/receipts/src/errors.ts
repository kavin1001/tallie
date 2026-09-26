export class ReceiptError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'ReceiptError';
  }
}
