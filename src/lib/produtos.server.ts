import { createIsomorphicFn } from "@tanstack/react-start";

export const getServerOrigin = createIsomorphicFn()
  .client(() => "")
  .server(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getRequest } = require("@tanstack/react-start/server");
      return new URL(getRequest().url).origin;
    } catch {
      return "";
    }
  });
