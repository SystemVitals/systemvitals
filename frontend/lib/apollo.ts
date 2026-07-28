"use client";
import { ApolloClient, InMemoryCache, HttpLink, ApolloLink } from "@apollo/client";

const httpLink = new HttpLink({ uri: `${process.env.NEXT_PUBLIC_API_URL}/graphql` });

const authLink = new ApolloLink((operation, forward) => {
  const token = typeof window !== "undefined" ? localStorage.getItem("sv_token") : null;
  if (token) {
    operation.setContext({ headers: { authorization: `Bearer ${token}` } });
  }
  return forward(operation);
});

export const apolloClient = new ApolloClient({
  link: authLink.concat(httpLink),
  cache: new InMemoryCache(),
});
