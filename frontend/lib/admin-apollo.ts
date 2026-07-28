"use client";
import { ApolloClient, HttpLink, InMemoryCache, ApolloLink } from "@apollo/client";

export function makeAdminApolloClient() {
  const auth = new ApolloLink((operation, forward) => {
    const token = typeof window !== "undefined" ? localStorage.getItem("sv_token") : null;
    operation.setContext({ headers: token ? { authorization: `Bearer ${token}` } : {} });
    return forward(operation);
  });
  const http = new HttpLink({ uri: `${process.env.NEXT_PUBLIC_API_URL}/admin/graphql` });
  return new ApolloClient({ link: ApolloLink.from([auth, http]), cache: new InMemoryCache() });
}
