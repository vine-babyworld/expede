// Server-only helpers. Blocked from client bundle by *.server.ts filename rule.
import { getRequest } from "@tanstack/react-start/server";

export function getServerOrigin(): string {
  try {
    return new URL(getRequest().url).origin;
  } catch {
    return "";
  }
}
