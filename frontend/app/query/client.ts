import { QueryClient } from "@tanstack/react-query";

/** One cache for HTTP hydration and durable websocket projections. */
export const appQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});
