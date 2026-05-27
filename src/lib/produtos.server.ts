import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

export const getServerOrigin = createIsomorphicFn()
  .client(() => "")
  .server(() => {
    try {
      return new URL(getRequest().url).origin;
    } catch {
      return "";
    }
  });
