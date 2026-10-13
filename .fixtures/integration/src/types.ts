/**
 * TypeScript source: shared types and constants
 */
export const APP_VERSION = "1.0.0";
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export function paginate<T>(items: T[], page: number, pageSize: number): PaginatedResult<T> {
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const slice = items.slice(start, end);
  return {
    items: slice,
    total: items.length,
    page,
    pageSize,
    hasMore: end < items.length,
  };
}

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number = 500,
  ) {
    super(message);
    this.name = "AppError";
  }
}
