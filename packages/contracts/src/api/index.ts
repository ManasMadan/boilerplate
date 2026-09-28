/**
 * The API contract: every procedure, its route, input, output and errors. The server
 * implements it (apps/api), clients call it (packages/client), and the OpenAPI document
 * for third parties is generated from it. Changing anything here is an API change:
 * CI compares the generated OpenAPI document against master and fails on breaking
 * changes (removed fields, new required inputs), which also protects older mobile apps.
 */
import { populateContractRouterPaths } from "@orpc/contract";
import { aiContract } from "./ai";
import { auditContract } from "./audit";
import { systemContract } from "./system";
import { todoContract } from "./todo";
import { userContract } from "./user";

export const contract = populateContractRouterPaths({
  system: systemContract,
  user: userContract,
  todo: todoContract,
  ai: aiContract,
  audit: auditContract,
});

export type Contract = typeof contract;

export * from "./ai";
export * from "./audit";
export * from "./base";
export * from "./system";
export * from "./todo";
export * from "./user";
