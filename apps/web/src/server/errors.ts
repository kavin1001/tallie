export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function notFound(): never {
  throw new AppError('NOT_FOUND', 'This item is not available in your account.', 404);
}
