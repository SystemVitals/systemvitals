"use client";
import { ApolloProvider } from "@apollo/client/react";
import { ReactNode } from "react";
import { apolloClient } from "@/lib/apollo";
export function ApolloClientProvider({ children }: { children: ReactNode }) {
  return <ApolloProvider client={apolloClient}>{children}</ApolloProvider>;
}
