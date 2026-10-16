/**
 * Single source of truth for the KLI harness URL.
 *
 * The Studio never talks to a model provider directly any more: every call
 * (chat, images, embeddings, audio, catalogue) is forwarded by `@kli/server`,
 * which owns the credentials. `lib/api.ts` reads this URL to build those
 * forwarded requests, and the store keeps it in sync with the persisted
 * `harnessUrl` (see `store/index.ts`). Kept in its own module to avoid a
 * circular import between the store and the API client.
 */

const DEFAULT_HARNESS_URL = 'http://127.0.0.1:4317';

let harnessBaseUrl = DEFAULT_HARNESS_URL;

function normalize(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : DEFAULT_HARNESS_URL;
}

export function setGatewayBaseUrl(url: string): void {
  harnessBaseUrl = normalize(url);
}

export function getGatewayBaseUrl(): string {
  return harnessBaseUrl;
}
