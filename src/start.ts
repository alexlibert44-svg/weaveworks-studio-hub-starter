import { createStart, createCsrfMiddleware, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
// Project-specific bearer middleware: it renews an expired token before the
// call, so server functions no longer fail with "Unauthorized: Invalid token".
import { attachFreshSupabaseAuth } from "@/lib/verba/auth-attach";
...
  functionMiddleware: [attachFreshSupabaseAuth],
  requestMiddleware: [errorMiddleware, csrfMiddleware],
}));
