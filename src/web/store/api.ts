import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import type { HealthResponse } from "../../server/types.js";

export const api = createApi({
  reducerPath: "api",
  baseQuery: fetchBaseQuery({ baseUrl: "/api" }),
  endpoints: (builder) => ({
    getHealth: builder.query<HealthResponse, void>({
      query: () => "/health",
    }),
  }),
});

export const { useGetHealthQuery } = api;
