import { AsyncLocalStorage } from "node:async_hooks";

const companyContext = new AsyncLocalStorage<string>();

export function runWithCompany<T>(companyId: string, callback: () => T): T {
  return companyContext.run(companyId, callback);
}

export function getCompanyContext() {
  return companyContext.getStore();
}
